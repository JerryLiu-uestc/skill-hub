# Skill Hub 市场架构改造 PRD — Route C

> 版本: v1.0 | 作者: Team Lead | 日期: 2026-06-23

## 1. 产品目标

将 Skill Hub 的市场功能从"运行时 GitHub API 实时发现"改造为"四层混合数据源架构"，实现：

- **首屏秒开**：内置索引，0 网络请求即可展示
- **热度实时**：GitHub Actions 每日抓取，通过 raw CDN 无限制分发
- **灵活扩展**：用户可添加自定义源（Registry JSON 或 GitHub Repo）
- **即用即装**：粘贴任意 GitHub URL 即可发现并安装 skill

## 2. 用户故事

| # | 角色 | 故事 | 优先级 |
|---|------|------|--------|
| US-1 | 用户 | 打开市场时，我能立即看到 skill 列表，不需要等待网络请求 | P0 |
| US-2 | 用户 | 我能粘贴一个 GitHub 链接，直接搜索并安装该仓库的 skill | P0 |
| US-3 | 用户 | 我能在设置中添加自定义市场源（Registry JSON URL 或 GitHub Repo URL） | P1 |
| US-4 | 用户 | 市场中的 skill 有热度排序，数据每天更新 | P1 |
| US-5 | 用户 | 我能看到每个 skill 的分类标签，方便筛选 | P2 |
| US-6 | 用户 | 离线状态下我仍能浏览内置索引中的 skill（安装仍需网络） | P1 |
| US-7 | 维护者 | 我能通过 GitHub Actions 自动更新远程索引，无需发版 | P0 |

## 3. 需求池

### P0（必须完成）

| ID | 需求 | 说明 |
|----|------|------|
| P0-1 | 内置索引文件 | 将 skill 元数据打包为 JSON，内嵌在 app 中，首次打开 0ms 展示 |
| P0-2 | index.json 数据格式 | 定义统一的 skill 索引 JSON Schema |
| P0-3 | 远程索引 fetch | App 后台异步从 `raw.githubusercontent.com` 拉取远程 index.json，合并覆盖本地 |
| P0-4 | GitHub Actions 工作流 | 每日 cron 遍历已知仓库，抓取 stars/updated_at/description，生成 index.json 并 commit |
| P0-5 | 粘贴链接模式 | 保留并优化现有 `discover_repo` 功能，支持任意 GitHub URL |
| P0-6 | 市场数据层重构 | 前端 `refreshMarket()` 改为：L1 内置 → L2 远程(后台) → L3 用户源(并行) → L4 粘贴(按需) |

### P1（应该完成）

| ID | 需求 | 说明 |
|----|------|------|
| P1-1 | 用户自定义源 — Registry JSON | 支持添加指向 index.json 格式的 URL 作为市场源 |
| P1-2 | 用户自定义源 — GitHub Repo | 保留现有 GitHub repo 实时发现能力作为源类型之一 |
| P1-3 | 源管理 UI | 设置页可添加/删除/启用/禁用源，显示每个源的加载状态 |
| P1-4 | 多源合并去重 | 市场页面合并所有启用源的数据，按 sourceUrl 去重 |
| P1-5 | 离线降级 | 网络不可用时仅展示 L1 内置索引 |
| P1-6 | 缓存策略 | L2 远程索引本地缓存 24h，过期后台刷新 |

### P2（可以做）

| ID | 需求 | 说明 |
|----|------|------|
| P2-1 | 分类标签筛选 | 基于 categories 字段的标签筛选 UI |
| P2-2 | 热度评分公式 | `hotness = stars * 1.0 + recency_bonus`，recency_bonus 按更新时间衰减 |
| P2-3 | 安装计数上报 | 匿名上报安装数到远程索引（可选，需隐私确认） |
| P2-4 | 源订阅市场 | 提供官方源订阅页面，一键添加推荐的第三方源 |

## 4. index.json 数据格式设计

### 4.1 顶层结构

```json
{
  "version": "1.0.0",
  "generatedAt": "2026-06-23T06:00:00Z",
  "totalCount": 42,
  "skills": [
    { ... SkillEntry }
  ]
}
```

### 4.2 SkillEntry 结构

```json
{
  "id": "skill-pdf-extract",
  "name": "PDF Extract",
  "kind": "skill",
  "summary": "Extract text and tables from PDF files",
  "description": "Full description with usage instructions...",
  "sourceUrl": "https://github.com/anthropics/skills/tree/main/document-skills/pdf",
  "repo": "anthropics/skills",
  "path": "document-skills/pdf/SKILL.md",
  "stars": 1234,
  "updatedAt": "2026-06-20T10:30:00Z",
  "categories": ["document", "pdf", "extraction"],
  "hotness": 1234.0,
  "author": "anthropics",
  "license": "MIT",
  "version": "1.0.0"
}
```

### 4.3 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | 是 | 全局唯一 ID，格式 `skill-{slug}` |
| `name` | string | 是 | 显示名称 |
| `kind` | "skill" \| "plugin" | 是 | 类型 |
| `summary` | string | 是 | 一句话描述 |
| `description` | string | 否 | 详细描述 |
| `sourceUrl` | string | 是 | GitHub 上的 SKILL.md 完整 URL |
| `repo` | string | 是 | `owner/repo` 格式 |
| `path` | string | 是 | 仓库内 SKILL.md 的相对路径 |
| `stars` | number | 是 | 仓库 star 数 |
| `updatedAt` | string (ISO 8601) | 是 | 仓库最后更新时间 |
| `categories` | string[] | 否 | 分类标签 |
| `hotness` | number | 是 | 热度评分，用于排序 |
| `author` | string | 否 | 仓库 owner |
| `license` | string | 否 | 开源协议 |
| `version` | string | 否 | skill 版本号 |

### 4.4 与现有 MarketEntry 的映射

现有 Rust `MarketEntry`:
```rust
pub struct MarketEntry {
    pub name: String,
    pub kind: HostKind,      // Codex | Claude → 对应 "skill" | "plugin"
    pub summary: String,
    pub source_url: String,
    pub skill_sha256: String, // 运行时计算，索引中不需要
    pub installed: bool,       // 运行时状态
    pub installed_id: Option<String>, // 运行时状态
    pub repo: String,
    pub stars: Option<i64>,
    pub origin: String,        // "featured" | "community" | "user-source"
}
```

新增字段（扩展 MarketEntry）:
- `categories: Vec<String>`
- `hotness: Option<f64>`
- `description: Option<String>`
- `updatedAt: Option<String>`
- `id: Option<String>` — 索引中的唯一 ID

## 5. 四层数据源架构

```
┌─────────────────────────────────────────────────────┐
│                   Market UI (React)                  │
│          合并去重 → 排序 → 渲染卡片列表               │
└──────────────┬──────────────────────────────────────┘
               │
    ┌──────────┼──────────┬──────────┬───────────┐
    ▼          ▼          ▼          ▼           
┌────────┐ ┌────────┐ ┌────────┐ ┌──────────┐
│  L1    │ │  L2    │ │  L3    │ │   L4     │
│ 内置   │ │ 远程   │ │ 用户源 │ │ 粘贴链接 │
│ 索引   │ │ 索引   │ │        │ │          │
│ (JSON) │ │ (JSON) │ │(JSON/  │ │(GitHub   │
│ 打包   │ │ raw    │ │ Repo)  │ │ URL)     │
│ 内嵌   │ │ CDN    │ │        │ │          │
├────────┤ ├────────┤ ├────────┤ ├──────────┤
│ 0ms    │ │ ~200ms │ │ 按需   │ │ 手动触发 │
│ 首屏   │ │ 后台   │ │ 并行   │ │ 单次请求 │
└────────┘ └────────┘ └────────┘ └──────────┘
```

| 层 | 来源 | 触发时机 | 延迟 | 缓存 |
|---|------|---------|------|------|
| L1 | 打包进 app 的 `built-in-index.json` | 首次打开 | 0ms | 永久（随版本更新） |
| L2 | `raw.githubusercontent.com` 上的 `index.json` | 后台异步，24h 刷新 | ~200ms | 24h TTL |
| L3a | 用户添加的 Registry JSON URL | 打开市场时并行 | 取决于源 | 30min TTL |
| L3b | 用户添加的 GitHub Repo URL | 打开市场时并行 | 取决于源 | 30min TTL |
| L4 | 任意 GitHub URL | 用户手动粘贴 | 单次请求 | 不缓存 |

## 6. 热度更新策略

### GitHub Actions 工作流

```yaml
# .github/workflows/update-market-index.yml
name: Update Market Index
on:
  schedule:
    - cron: '0 6 * * *'  # 每天 UTC 06:00
  workflow_dispatch: {}   # 手动触发

jobs:
  build-index:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: '3.12' }
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

### 索引生成脚本 (`scripts/generate_index.py`)

输入：`scripts/skill-repos.json`（已知 skill 仓库列表）
输出：`dist-index/index.json`

流程：
1. 读取 `skill-repos.json` 获取仓库列表
2. 对每个仓库调 GitHub API:
   - `GET /repos/{owner}/{repo}` → stars, updated_at, description, license
   - `GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=1` → 找 SKILL.md 路径
3. 对每个 SKILL.md 调 raw fetch 获取 frontmatter
4. 计算 hotness 评分
5. 生成 `index.json`，写入 `dist-index/`

### 热度评分公式

```
hotness = stars * 1.0 + recency_bonus

recency_bonus:
  - 7天内更新: +100
  - 30天内更新: +50
  - 90天内更新: +20
  - 更久: +0
```

## 7. 待确认问题

| # | 问题 | 当前建议 |
|---|------|---------|
| Q1 | 内置索引初始包含哪些 skill？ | 当前 17 个 curated + WorkBuddy 推荐市场中的 skill |
| Q2 | 远程索引放在哪个分支/仓库？ | 当前仓库的 `gh-pages` 分支，路径 `/index.json` |
| Q3 | 用户自定义源是否需要支持认证？ | 暂不支持，仅公开 URL |
| Q4 | 是否需要支持非 GitHub 源（如 GitLab）？ | 暂不支持，仅 GitHub |
| Q5 | 粘贴链接模式是否需要历史记录？ | P2，后续迭代 |
| Q6 | 内置索引更新是否随 app 版本更新？ | 是，每次发版时重新生成打包 |

## 8. 不做的事情

- 不搭建后端服务器（纯 GitHub Actions + raw CDN）
- 不做用户账号系统
- 不做 skill 评分/评论
- 不做自动安装更新（仅提示有更新）
