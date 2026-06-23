# Skill Hub 市场架构改造 — 系统设计文档

> 基于 PRD Route C，精确到文件、函数、行号

## 1. 改动总览

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `app/src-tauri/src/lib.rs` | 修改 | 扩展结构体 + 新增函数 + 新增 Tauri 命令 |
| `app/src/types.ts` | 修改 | 扩展 MarketEntry 接口 |
| `app/src/App.tsx` | 修改 | 重构 refreshMarket + 新增 L1/L2 加载逻辑 |
| `app/src-tauri/tauri.conf.json` | 修改 | 添加 resources 配置打包 JSON |
| `app/src-tauri/resources/built-in-index.json` | 新增 | 内置索引文件 |
| `scripts/generate_index.py` | 新增 | GitHub Actions 索引生成脚本 |
| `scripts/skill-repos.json` | 新增 | 已知 skill 仓库列表 |
| `.github/workflows/update-market-index.yml` | 新增 | GitHub Actions 工作流 |

## 2. Rust 后端设计 (lib.rs)

### 2.1 扩展 MarketEntry 结构体 (lib.rs:121-136)

当前：
```rust
pub struct MarketEntry {
    pub name: String,
    pub kind: ResourceKind,
    pub summary: Option<String>,
    pub source_url: String,
    pub skill_sha256: Option<String>,
    pub installed: bool,
    pub installed_id: Option<String>,
    pub repo: Option<String>,
    pub stars: Option<u64>,
    pub origin: String,
}
```

新增字段：
```rust
    /// 分类标签，来自索引
    #[serde(skip_serializing_if = "Option::is_none")]
    pub categories: Option<Vec<String>>,
    /// 热度评分，来自索引
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hotness: Option<f64>,
    /// 详细描述
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// 仓库最后更新时间 (ISO 8601)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    /// 索引中的唯一 ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index_id: Option<String>,
```

### 2.2 扩展 MarketCandidate 结构体 (lib.rs:946-955)

同步添加相同的新字段，并在 `assemble_market()` (lib.rs:1017-1028) 中传递。

### 2.3 新增：索引文件反序列化结构

在 `GitHubIndexEntry` (lib.rs:110-117) 附近新增：

```rust
/// 顶层索引文件结构
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarketIndexFile {
    version: String,
    generated_at: String,
    #[serde(default)]
    total_count: u32,
    skills: Vec<MarketIndexEntry>,
}

/// 索引文件中的单个 skill 条目
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarketIndexEntry {
    id: String,
    name: String,
    kind: String,           // "skill" | "plugin"
    summary: Option<String>,
    description: Option<String>,
    source_url: String,
    repo: String,
    path: String,
    #[serde(default)]
    stars: u64,
    updated_at: Option<String>,
    #[serde(default)]
    categories: Vec<String>,
    #[serde(default)]
    hotness: f64,
    author: Option<String>,
    license: Option<String>,
    version: Option<String>,
}

impl MarketIndexEntry {
    fn to_candidate(&self) -> MarketCandidate {
        let kind = match self.kind.as_str() {
            "plugin" => ResourceKind::Plugin,
            _ => ResourceKind::Skill,
        };
        MarketCandidate {
            name: self.name.clone(),
            kind,
            summary: self.summary.clone(),
            source_url: self.source_url.clone(),
            skill_sha256: None,
            repo: Some(self.repo.clone()),
            stars: Some(self.stars),
            origin: "index".to_string(),
            categories: Some(self.categories.clone()),
            hotness: Some(self.hotness),
            description: self.description.clone(),
            updated_at: self.updated_at.clone(),
            index_id: Some(self.id.clone()),
        }
    }
}
```

### 2.4 新增：加载内置索引

```rust
/// 读取打包在 app resources 中的 built-in-index.json。
/// 首屏数据源，0 网络请求。
fn load_builtin_index() -> Vec<MarketCandidate> {
    // Tauri 资源路径: resources/built-in-index.json
    // 在编译时通过 tauri.conf.json 的 bundle.resources 打包
    let json = include_str!("../resources/built-in-index.json");
    match serde_json::from_str::<MarketIndexFile>(json) {
        Ok(index) => index.skills.iter().map(|e| e.to_candidate()).collect(),
        Err(_) => {
            // 降级到硬编码 curated 列表
            curated_official_candidates()
        }
    }
}
```

**注意**：使用 `include_str!` 宏在编译时嵌入 JSON，不需要运行时文件 I/O。

### 2.5 新增：获取远程索引

```rust
const REMOTE_INDEX_CACHE_FILENAME: &str = "remote-market-index.json";
const REMOTE_INDEX_TTL_SECS: u64 = 24 * 60 * 60; // 24 hours

/// 从远程 URL 获取索引 JSON，带本地文件缓存。
fn fetch_remote_index(
    url: &str,
    cache_dir: &Path,
) -> HubResult<Vec<MarketCandidate>> {
    // 检查本地缓存
    let cache_path = cache_dir.join(REMOTE_INDEX_CACHE_FILENAME);
    if let Ok(cached) = fs::read_to_string(&cache_path) {
        if let Ok(index) = serde_json::from_str::<MarketIndexFile>(&cached) {
            if let Ok(generated) = parse_iso8601(&index.generated_at) {
                if generated.elapsed().as_secs() < REMOTE_INDEX_TTL_SECS {
                    return Ok(index.skills.iter().map(|e| e.to_candidate()).collect());
                }
            }
        }
    }

    // 缓存过期或不存在，从远程拉取
    let client = market_discovery_http_client()?;
    let response = client.get(url).send().map_err(|e| {
        SkillHubError::Io(format!("Failed to fetch remote index: {e}"))
    })?;
    let body = response.text().map_err(|e| {
        SkillHubError::Io(format!("Failed to read remote index body: {e}"))
    })?;

    // 写入缓存
    let _ = fs::write(&cache_path, &body);

    let index: MarketIndexFile = serde_json::from_str(&body).map_err(|e| {
        SkillHubError::Io(format!("Failed to parse remote index: {e}"))
    })?;
    Ok(index.skills.iter().map(|e| e.to_candidate()).collect())
}
```

### 2.6 修改 browse_market_v2 (lib.rs:1144-1178)

新增参数 `remote_index_url` 和 `cache_dir`：

```rust
pub fn browse_market_v2(
    sources: &[String],
    token: Option<&str>,
    include_curated: bool,
    resources: &[SkillResource],
    remote_index_url: Option<&str>,  // 新增
    cache_dir: Option<&Path>,        // 新增
) -> (Vec<MarketEntry>, Vec<String>) {
    let mut candidates = Vec::new();
    let mut warnings = Vec::new();

    // L1: 内置索引（替代旧的 curated_official_candidates）
    if include_curated {
        candidates.extend(load_builtin_index());
    }

    // L2: 远程索引（后台刷新，失败不阻断）
    if let Some(url) = remote_index_url {
        if let Some(dir) = cache_dir {
            match fetch_remote_index(url, dir) {
                Ok(found) => candidates.extend(found),
                Err(error) => warnings.push(format!("remote-index: {error}")),
            }
        }
    }

    // L3: 用户自定义源（保持不变）
    for source in sources.iter().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        let result = if source.to_ascii_lowercase().ends_with(".json") {
            fetch_github_index(source).map(|entries| {
                entries.into_iter().map(MarketCandidate::from_index_entry).collect()
            })
        } else {
            discover_repo_skill_candidates(source, token)
        };
        match result {
            Ok(found) => candidates.extend(found),
            Err(error) => warnings.push(format!("{source}: {error}")),
        }
    }

    (assemble_market(candidates, resources), warnings)
}
```

### 2.7 新增 Tauri 命令

```rust
/// L1: 返回内置索引，0 网络请求，首屏秒开
#[tauri::command]
fn discover_builtin_index(resources: Vec<SkillResource>) -> Result<MarketResult, String> {
    let candidates = load_builtin_index();
    let entries = assemble_market(candidates, &resources);
    Ok(MarketResult { entries, warnings: vec![] })
}

/// L2: 获取远程索引（带缓存），用于后台刷新
#[tauri::command]
async fn refresh_remote_index(
    url: Option<String>,
    resources: Vec<SkillResource>,
    app_data_dir: String,
) -> Result<MarketResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let url = url.unwrap_or_else(|| {
            "https://raw.githubusercontent.com/JerryLiu-uestc/skill-hub/gh-pages/index.json".to_string()
        });
        let cache_dir = PathBuf::from(&app_data_dir);
        match fetch_remote_index(&url, &cache_dir) {
            Ok(candidates) => {
                let entries = assemble_market(candidates, &resources);
                Ok(MarketResult { entries, warnings: vec![] })
            }
            Err(error) => Ok(MarketResult {
                entries: vec![],
                warnings: vec![error.to_string()],
            }),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
```

### 2.8 修改 discover_market 命令 (lib.rs:274-291)

传递新参数：

```rust
#[tauri::command]
async fn discover_market(
    sources: Vec<String>,
    token: Option<String>,
    include_curated: Option<bool>,
    resources: Vec<SkillResource>,
    remote_index_url: Option<String>,  // 新增
    app_data_dir: Option<String>,      // 新增
) -> Result<MarketResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cache_dir = app_data_dir.as_ref().map(PathBuf::from);
        let (entries, warnings) = browse_market_v2(
            &sources,
            token.as_deref(),
            include_curated.unwrap_or(true),
            &resources,
            remote_index_url.as_deref(),
            cache_dir.as_deref(),
        );
        Ok(MarketResult { entries, warnings })
    })
    .await
    .map_err(|error| error.to_string())?
}
```

### 2.9 注册新命令 (lib.rs:2400-2414)

```rust
.invoke_handler(tauri::generate_handler![
    scan_inventory,
    match_github_sources,
    browse_market,
    discover_market,
    discover_market_source,
    discover_curated_catalog,
    discover_repo,
    discover_builtin_index,      // 新增
    refresh_remote_index,        // 新增
    install_github_skill,
    check_skill_update,
    update_github_skill,
    preview_source,
    install_resource,
    delete_resource
])
```

### 2.10 修改 sort_market (lib.rs:1036-1048)

增加 hotness 排序支持：

```rust
fn sort_market(market: &mut [MarketEntry]) {
    market.sort_by(|left, right| {
        // 优先按 hotness 排序（如果都有）
        let left_hot = left.hotness.unwrap_or(0.0);
        let right_hot = right.hotness.unwrap_or(0.0);
        if right_hot != left_hot {
            return right_hot.partial_cmp(&left_hot).unwrap_or(std::cmp::Ordering::Equal);
        }
        // 降级到 stars
        right.stars.unwrap_or(0).cmp(&left.stars.unwrap_or(0))
            .then_with(|| {
                left.name.to_ascii_lowercase()
                    .cmp(&right.name.to_ascii_lowercase())
            })
    });
}
```

## 3. React 前端设计 (App.tsx)

### 3.1 扩展 AppSettings (App.tsx:45-53)

```typescript
interface AppSettings {
  language: Language;
  theme: Theme;
  extraSkillPaths: string[];
  githubMatchingEnabled: boolean;
  githubIndexUrls: string[];
  marketSources: string[];
  githubToken: string;
  // 新增
  remoteIndexUrl: string;           // L2 远程索引 URL
  customRegistrySources: string[];  // L3a Registry JSON 源
}
```

默认值：
```typescript
const DEFAULT_REMOTE_INDEX_URL =
  "https://raw.githubusercontent.com/JerryLiu-uestc/skill-hub/gh-pages/index.json";
```

### 3.2 重构 refreshMarket (App.tsx:398-531)

新流程：
```
Step 1: L1 内置索引 → 同步调用 discover_builtin_index → 立即渲染
Step 2: L2 远程索引 → 后台调用 refresh_remote_index → 静默合并
Step 3: L3 用户源 → 并行调用 discover_market_source → 渐进合并
Step 4: 合并去重 → 排序 → 最终渲染
```

关键改动：
- 移除 `MARKET_LOADER_MIN_MS = 1200` 的人工延迟（或降为 0）
- L1 结果先渲染，不等 L2/L3
- L2/L3 完成后渐进式合并到已有列表

```typescript
async function refreshMarket({ force = false, background = false } = {}) {
    if (initialMarket) return;
    if (!force) {
        const cached = readMarketCache(settings);
        if (cached) {
            setMarket(cached.entries);
            setMarketCachedAt(cached.cachedAt);
            if (!background) {
                setNotice(`${text.marketLoadedFromCache} ${formatCachedAt(cached.cachedAt)}`);
            }
            return;
        }
    }

    setMarketLoading(true);
    setSourceStates({});
    if (!background) setNotice(text.marketLoading);

    const token = settings.githubToken || null;
    const sources = settings.marketSources.filter((s) => s.trim().length > 0);
    const currentResources = resources;

    // 初始化源状态
    const initial: Record<string, SourceState> = {};
    initial["__builtin__"] = { label: "Built-in Index", status: "loading" };
    initial["__remote__"] = { label: "Remote Index", status: "loading" };
    for (const source of sources) {
        initial[source] = { label: sourceUrlLabel(source), status: "loading" };
    }
    setSourceStates(initial);

    const nextStates: Record<string, SourceState> = { ...initial };
    const entries: MarketEntry[] = [];

    const dedupeEntries = () => {
        const seen = new Set<string>();
        return entries.filter((entry) => {
            if (seen.has(entry.sourceUrl)) return false;
            seen.add(entry.sourceUrl);
            return true;
        });
    };

    const commitProgress = () => {
        setSourceStates({ ...nextStates });
        setMarket(dedupeEntries());
    };

    const loadSource = async (key: string, task: Promise<MarketResult>) => {
        try {
            const result = await withTimeout(task, MARKET_SOURCE_TIMEOUT_MS, text.marketSourceTimedOut);
            nextStates[key] = {
                label: nextStates[key]?.label ?? key,
                status: result.entries.length > 0 || result.warnings.length === 0 ? "success" : "error",
                count: result.entries.length,
                error: result.warnings[0],
            };
            entries.push(...result.entries);
        } catch (error) {
            nextStates[key] = {
                label: nextStates[key]?.label ?? key,
                status: "error",
                error: String(error).slice(0, 120),
            };
        }
        commitProgress();
    };

    // Step 1: L1 内置索引 — 同步优先加载
    await loadSource(
        "__builtin__",
        onDiscoverBuiltinIndex
            ? Promise.resolve(onDiscoverBuiltinIndex())
            : invoke<MarketResult>("discover_builtin_index", { resources: currentResources }),
    );

    // Step 2 + 3: L2 远程索引 + L3 用户源 — 并行
    const tasks: Promise<void>[] = [
        loadSource(
            "__remote__",
            invoke<MarketResult>("refresh_remote_index", {
                url: settings.remoteIndexUrl || DEFAULT_REMOTE_INDEX_URL,
                resources: currentResources,
                appDataDir: await getAppDataDir(),
            }),
        ),
    ];

    for (const source of sources) {
        tasks.push(
            loadSource(
                source,
                onDiscoverMarketSource
                    ? Promise.resolve(onDiscoverMarketSource(source))
                    : invoke<MarketResult>("discover_market_source", { source, token, resources: currentResources }),
            ),
        );
    }

    await Promise.allSettled(tasks);

    // 最终合并
    const nextMarket = dedupeEntries();
    setSourceStates({ ...nextStates });
    setMarket(nextMarket);

    const cachedAt = Date.now();
    setMarketCachedAt(cachedAt);
    writeMarketCache(settings, nextMarket, cachedAt);

    setMarketLoading(false);
    if (!background) {
        setNotice(text.marketLoaded);
    }
}
```

### 3.3 移除 MARKET_LOADER_MIN_MS

```typescript
// 删除或改为 0
const MARKET_LOADER_MIN_MS = 0;
```

### 3.4 AppProps 新增回调

```typescript
interface AppProps {
    // ... 现有 ...
    onDiscoverBuiltinIndex?: () => MarketResult | Promise<MarketResult>;  // 新增
}
```

### 3.5 loadSettings 兼容

在 `loadSettings()` 中添加新字段的默认值：

```typescript
remoteIndexUrl: parsed.remoteIndexUrl ?? DEFAULT_REMOTE_INDEX_URL,
customRegistrySources: Array.isArray(parsed.customRegistrySources)
    ? parsed.customRegistrySources.filter(...)
    : [],
```

## 4. types.ts 修改

扩展 MarketEntry 接口 (types.ts:28-39)：

```typescript
export interface MarketEntry {
  name: string;
  kind: Exclude<ResourceKind, "unknown">;
  summary: string | null;
  sourceUrl: string;
  skillSha256: string | null;
  installed: boolean;
  installedId: string | null;
  repo: string | null;
  stars: number | null;
  origin: "official" | "community" | "index" | string;
  // 新增
  categories?: string[];
  hotness?: number;
  description?: string;
  updatedAt?: string;
  indexId?: string;
}
```

## 5. tauri.conf.json 修改

添加 resources 配置，将 built-in-index.json 打包进 app：

```json
{
  "bundle": {
    "resources": ["resources/built-in-index.json"]
  }
}
```

## 6. 内置索引文件 (built-in-index.json)

初始版本包含当前 17 个 curated skill，格式见 PRD 4.2 节。

生成方式：从现有 `CURATED_OFFICIAL` 常量转换，stars 设为 anthropics/skills 仓库的实际值。

## 7. GitHub Actions 索引生成

### 7.1 scripts/skill-repos.json

```json
[
  {
    "repo": "anthropics/skills",
    "branch": "main",
    "skillPath": "skills"
  },
  {
    "repo": "obra/superpowers",
    "branch": "main",
    "skillPath": "skills"
  },
  {
    "repo": "anthropics/claude-plugins-official",
    "branch": "main",
    "skillPath": "."
  }
]
```

### 7.2 scripts/generate_index.py

Python 脚本，使用 GitHub API：
1. 读取 `skill-repos.json`
2. 对每个仓库调 `/repos/{owner}/{repo}` 获取 stars, updated_at
3. 调 `/repos/{owner}/{repo}/git/trees/{branch}?recursive=1` 找 SKILL.md
4. 对每个 SKILL.md 调 raw fetch 获取 frontmatter (name, description)
5. 计算 hotness 评分
6. 输出 `dist-index/index.json`

### 7.3 .github/workflows/update-market-index.yml

```yaml
name: Update Market Index
on:
  schedule:
    - cron: '0 6 * * *'
  workflow_dispatch: {}
  push:
    paths: ['scripts/skill-repos.json']

jobs:
  build-index:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - name: Install dependencies
        run: pip install requests pyyaml
      - name: Generate index
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: python scripts/generate_index.py
      - name: Publish to gh-pages
        uses: peaceiris/actions-gh-pages@v4
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: ./dist-index
```

## 8. 实现任务分解

| Task # | 任务 | 文件 | 依赖 |
|--------|------|------|------|
| T1 | 创建 built-in-index.json（从 CURATED_OFFICIAL 转换） | `app/src-tauri/resources/built-in-index.json` | 无 |
| T2 | Rust: 扩展结构体 + 新增索引类型 + 新增函数 | `lib.rs` | T1 |
| T3 | Rust: 修改 browse_market_v2 + 新增 Tauri 命令 + 注册 | `lib.rs` | T2 |
| T4 | Rust: 修改 sort_market 支持 hotness | `lib.rs` | T2 |
| T5 | tauri.conf.json: 添加 resources 配置 | `tauri.conf.json` | T1 |
| T6 | types.ts: 扩展 MarketEntry | `types.ts` | 无 |
| T7 | App.tsx: 扩展 AppSettings + loadSettings | `App.tsx` | T6 |
| T8 | App.tsx: 重构 refreshMarket | `App.tsx` | T3, T7 |
| T9 | App.tsx: 移除 MARKET_LOADER_MIN_MS | `App.tsx` | T8 |
| T10 | scripts/generate_index.py + skill-repos.json | `scripts/` | 无 |
| T11 | .github/workflows/update-market-index.yml | `.github/workflows/` | T10 |
| T12 | 编译验证 + 修复错误 | 全项目 | T3, T8 |

## 9. 风险和注意事项

1. **include_str! 路径**：`include_str!("../resources/built-in-index.json")` 是相对于 `lib.rs` 的路径，需验证编译时路径正确
2. **向后兼容**：旧的 `discover_curated_catalog` 命令保留，内部改为调用 `load_builtin_index()`，确保前端旧版本不受影响
3. **Tauri 资源路径**：`include_str!` 在编译时嵌入，不需要运行时资源解析，但需要确保 JSON 文件在构建前存在
4. **reqwest blocking**：远程索引获取复用现有的 `market_discovery_http_client()`，保持 blocking 模式一致
5. **缓存目录**：`app_data_dir` 由前端通过 Tauri API 获取后传给后端
