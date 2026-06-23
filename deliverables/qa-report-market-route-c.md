# QA 报告：市场架构改造（Route C）

**审查人**：严过关（Yan），QA 工程师  
**审查日期**：2026-06-23  
**审查范围**：`scripts/generate_index.py`、`scripts/skill-repos.json`、`.github/workflows/update-market-index.yml`、`app/src-tauri/resources/built-in-index.json`  
**Rust 结构体参考**：`app/src-tauri/src/lib.rs` 第 122-160 行

---

## 任务 1：验证内置索引 JSON 格式与 Rust 结构体匹配

**文件**：`app/src-tauri/resources/built-in-index.json`  
**参考结构体**：`MarketIndexFile` 和 `MarketIndexEntry`（`lib.rs` 第 122-160 行）

### 验证结果：✅ PASS

### 详细比对

| Rust 字段（serde camelCase） | JSON 字段 | 类型匹配 | 备注 |
|---|---|---|---|
| `version: String` | `version` | ✅ | `"1.0.0"` |
| `generated_at: String` | `generatedAt` | ✅ | `"2026-06-23T00:00:00Z"` |
| `total_count: u32` (`default`) | `totalCount` | ✅ | `17`，整数匹配 u32 |
| `skills: Vec<MarketIndexEntry>` | `skills` | ✅ | 17 个元素的数组 |
| `id: String` | `id` | ✅ | 每个条目都存在 |
| `name: String` | `name` | ✅ | 每个条目都存在 |
| `kind: String` | `kind` | ✅ | `"skill"` |
| `summary: Option<String>` | `summary` | ✅ | 每个条目都存在且为字符串 |
| `description: Option<String>` | `description` | ✅ | 每个条目都存在且为字符串 |
| `source_url: String` | `sourceUrl` | ✅ | camelCase 正确 |
| `repo: String` | `repo` | ✅ | 每个条目都存在 |
| `path: String` | `path` | ✅ | 每个条目都存在 |
| `stars: u64` (`default`) | `stars` | ✅ | `15000`，整数匹配 u64 |
| `updated_at: Option<String>` | `updatedAt` | ✅ | 每个条目都存在且为 ISO 8601 字符串 |
| `categories: Vec<String>` (`default`) | `categories` | ✅ | 字符串数组 |
| `hotness: f64` (`default`) | `hotness` | ✅ | `15100.0`，浮点数匹配 f64 |
| `author: Option<String>` | `author` | ✅ | 每个条目都存在且为字符串 |
| `license: Option<String>` | `license` | ✅ | 每个条目都存在且为字符串 |
| `version: Option<String>` | `version` | ✅ | 每个条目都存在且为字符串 |

### 发现的问题

**⚠️ 警告（非阻塞性）**：所有 17 个条目的 `stars` 均为 `15000`，`hotness` 均为 `15100.0`，`updatedAt` 均为 `"2026-06-20T10:30:00Z"`。这看起来是手工构造的示例数据，而非从 GitHub API 实时获取。当 `generate_index.py` 实际运行后，内置索引会被真实数据覆盖，此处不影响格式正确性。

---

## 任务 2：验证 Python 脚本生成的 JSON 格式与内置索引一致

**文件**：`scripts/generate_index.py`

### 验证结果：✅ PASS

### 详细比对

#### 2.1 顶层结构（`main()` 函数，第 368-373 行）

| 字段 | Python 代码 | 格式正确？ |
|---|---|---|
| `version` | `"version": "1.0.0"` | ✅ |
| `generatedAt` | `"generatedAt": datetime.now(...).strftime(...)` | ✅ camelCase |
| `totalCount` | `"totalCount": len(all_entries)` | ✅ camelCase，整数 |
| `skills` | `"skills": all_entries` | ✅ |

#### 2.2 条目结构（`build_entry()` 函数，第 316-332 行）

| 字段 | Python 代码 | 类型 | 正确？ |
|---|---|---|---|
| `id` | `"id": skill_id` | str | ✅ |
| `name` | `"name": name` | str | ✅ |
| `kind` | `"kind": kind` | str (`"skill"` 或 `"plugin"`) | ✅ |
| `summary` | `"summary": summary` | str | ✅ |
| `description` | `"description": description` | str | ✅ |
| `sourceUrl` | `"sourceUrl": source_url` | str | ✅ camelCase |
| `repo` | `"repo": full_repo` | str | ✅ |
| `path` | `"path": filepath` | str | ✅ |
| `stars` | `"stars": repo_info.get("stars", 0)` | int | ✅ 匹配 u64 |
| `updatedAt` | `"updatedAt": repo_info.get("updated_at", "")` | str | ✅ camelCase |
| `categories` | `"categories": categories` | list | ✅ 匹配 Vec<String> |
| `hotness` | `"hotness": hotness` | float | ✅ 匹配 f64 |
| `author` | `"author": owner` | str | ✅ |
| `license` | `"license": repo_info.get("license")` | str 或 None | ✅ 匹配 Option<String> |
| `version` | `"version": str(version)` | str | ✅ 匹配 Option<String> |

#### 2.3 camelCase 转换验证

Rust 结构体使用 `#[serde(rename_all = "camelCase")]`，Python 脚本直接输出 camelCase 字段名：

- `source_url` → `sourceUrl`：Python 第 322 行输出 `sourceUrl` ✅
- `updated_at` → `updatedAt`：Python 第 326 行输出 `updatedAt` ✅
- `generated_at` → `generatedAt`：Python 第 370 行输出 `generatedAt` ✅
- `total_count` → `totalCount`：Python 第 371 行输出 `totalCount` ✅

#### 2.4 发现的问题

**⚠️ 潜在问题**：当 `repo_info.get("license")` 返回 `None` 时，JSON 中会写入 `"license": null`。`Option<String>` 可以正确处理 `null`，所以反序列化不会失败。但如果希望省略 `null` 字段以减小文件体积，可以在 `json.dump` 时添加 `default=str` 并处理 None → 省略（需要自定义序列化）。当前实现功能上正确，不影响 PASS。

**⚠️ 潜在问题**：`updatedAt` 在 Python 中默认为空字符串 `""` 而非 `None`。Rust 的 `Option<String>` 会将 `""` 反序列化为 `Some("")`。如果希望表示为"无数据"，应改为 `None`。当前实现不会报错，但语义上 `""` 和 `None` 不同。

---

## 任务 3：验证 GitHub Actions 工作流

**文件**：`.github/workflows/update-market-index.yml`

### 验证结果：⚠️ PASS（有小问题）

### 详细检查

| 检查项 | 状态 | 说明 |
|---|---|---|
| cron 触发时间 | ✅ | `0 6 * * *`（每日 UTC 06:00），频率合理 |
| 手动触发 | ✅ | `workflow_dispatch: {}` 已配置 |
| push 触发 | ✅ | `paths: ['scripts/skill-repos.json']` 合理 |
| Python 版本 | ✅ | `3.12`，较新且稳定 |
| 依赖安装 | ✅ | `pip install requests pyyaml`，与脚本 import 一致 |
| GH_TOKEN 传递 | ✅ | `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` |
| gh-pages 发布 | ✅ | `peaceiris/actions-gh-pages@v4` |
| publish_dir | ✅ | `./dist-index`，与脚本默认 OUTPUT_DIR 一致 |

### 发现的问题

**❌ FAIL：`secrets.GITHUB_TOKEN` 引用方式不正确**

在第 27 行和第 32 行，工作流使用 `${{ secrets.GITHUB_TOKEN }}`。在 GitHub Actions 中，默认的 GITHUB_TOKEN 应通过 `${{ github.token }}` 访问，或者更常见的写法是不需要 `secrets.` 前缀，因为 GITHUB_TOKEN 是自动注入的环境变量。

正确写法：
```yaml
# 方式 1：使用 github.token（推荐）
GH_TOKEN: ${{ github.token }}

# 方式 2：GITHUB_TOKEN 作为环境变量自动可用，无需显式传递
# Python 脚本可以直接读取 GITHUB_TOKEN 环境变量
```

实际上，`secrets.GITHUB_TOKEN` 在某些 GitHub Actions 版本中是可以工作的，但更标准和可靠的写法是 `${{ github.token }}`。

**建议修复**（`update-market-index.yml` 第 27 行）：
```yaml
# 修改前
GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
# 修改后
GH_TOKEN: ${{ github.token }}
```

**⚠️ 警告：gh-pages 发布权限可能不足**

`peaceiris/actions-gh-pages@v4` 需要适当的权限才能推送到 gh-pages 分支。当前工作流配置了 `permissions: contents: write`，但这可能不足以完成 gh-pages 发布。建议添加 `pages: write` 和 `id-token: write` 权限（如果需要部署到 GitHub Pages 网站），或者如果只是推送到 gh-pages 分支，则 `contents: write` 已足够。

经确认：`peaceiris/actions-gh-pages@v4` 在默认模式下（`publish_branch: gh-pages`）只需要 `contents: write` 权限。当前配置正确。

**⚠️ 警告：缺少 ERROR 处理**

如果 Python 脚本执行失败（返回非零退出码），工作流不会报错并阻止发布。建议添加错误处理或至少让工作流在脚本失败时失败（`run` 步骤默认会在非零退出码时失败，所以实际上已经有这个行为——这条是误报）。

---

## 任务 4：验证 skill-repos.json

**文件**：`scripts/skill-repos.json`

### 验证结果：✅ PASS

### 详细检查

- JSON 格式：有效 ✅
- 顶层结构：JSON 数组 ✅
- 每个元素的必需字段：
  - `repo`：存在且格式为 `"owner/name"` ✅
  - `branch`：存在 ✅
  - `skillPath`：存在 ✅
- 包含的仓库：
  1. `anthropics/skills` — 有效 ✅
  2. `obra/superpowers` — 有效 ✅
  3. `anthropics/claude-plugins-official` — 有效 ✅

### 发现的问题

**无**。

---

## 任务 5：Python 脚本语法检查

**命令**：`python3 -c "import ast; ast.parse(open('scripts/generate_index.py').read()); print('Syntax OK')"`

### 验证结果：✅ PASS

```
Syntax OK
```

---

## 汇总

| 任务 | 结果 | 阻塞？ |
|---|---|---|
| 任务 1：内置索引 JSON vs Rust 结构体 | ✅ PASS | — |
| 任务 2：Python 脚本输出格式 vs 内置索引 | ✅ PASS | — |
| 任务 3：GitHub Actions 工作流 | ⚠️ PASS（有小问题） | 否 |
| 任务 4：skill-repos.json 格式 | ✅ PASS | — |
| 任务 5：Python 语法检查 | ✅ PASS | — |

### 需要修复的问题

| 优先级 | 文件 | 行号 | 问题描述 | 建议 |
|---|---|---|---|---|
| 🔴 高 | `.github/workflows/update-market-index.yml` | 27 | `secrets.GITHUB_TOKEN` 应改为 `github.token` | 修改为 `GH_TOKEN: ${{ github.token }}` |
| 🟡 中 | `scripts/generate_index.py` | 326 | `updatedAt` 默认值为 `""` 而非 `None` | 将 `repo_info.get("updated_at", "")` 改为 `repo_info.get("updated_at")` 以返回 None |
| 🟡 中 | `scripts/generate_index.py` | 331 | `license` 为 `None` 时输出 `null` | 功能上正确，但可考虑在 JSON 中省略 `null` 字段 |

### 总体结论

**整体状态：✅ PASS（有 1 个高优先级问题需要修复）**

市场架构改造涉及的 4 个新增文件的格式正确性基本满足要求。主要问题是 GitHub Actions 工作流中的 `GITHUB_TOKEN` 引用方式，建议修复后再合并。
