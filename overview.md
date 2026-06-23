# Skill Hub 市场架构改造 — 交付总览

## TL;DR

将 Skill Hub 市场从"GitHub API 实时发现"改造为 Route C 四层架构（内置索引 + GitHub Actions 远程索引 + 用户自定义源 + 粘贴链接），首屏从秒级加载降至 0ms，彻底消除 GitHub API 速率限制瓶颈。

## 交付概览

| 维度 | 状态 |
|------|------|
| Rust 编译 (`cargo check`) | ✅ 0 errors |
| TypeScript 编译 (`tsc --noEmit`) | ✅ 0 errors |
| 前端生产构建 (`vite build`) | ✅ 成功 (253KB gzipped) |
| Python 脚本语法检查 | ✅ Syntax OK |
| 内置索引 JSON 格式验证 | ✅ 17 个 skill，格式匹配 Rust 结构体 |
| QA 报告 | ✅ PASS（2 个问题已修复） |

## 架构设计

### 四层数据源

| 层 | 来源 | 触发时机 | 延迟 |
|---|------|---------|------|
| **L1 内置索引** | 打包进 app 的 `built-in-index.json` | 首次打开 | **0ms** |
| **L2 远程索引** | `raw.githubusercontent.com` 上的 JSON（GitHub Actions 每天 cron 生成） | 后台异步刷新 | ~200ms |
| **L3 用户源** | 用户添加的 GitHub repo URL | 按需拉取 | 取决于源 |
| **L4 粘贴链接** | 任意 GitHub URL | 用户手动粘贴 | 单次请求 |

### 热度更新策略

GitHub Actions 每天 UTC 06:00 cron 跑 Python 脚本 → 遍历已知 skill 仓库 → 获取 stars/updated_at → 生成 `index.json` → commit 到 `gh-pages` 分支 → App 后台 fetch `raw.githubusercontent.com`（无速率限制）。

热度公式：`hotness = stars × 1.0 + recency_bonus`（7天+100, 30天+50, 90天+20）

## 文件清单

### 新增文件
| 文件 | 说明 |
|------|------|
| `app/src-tauri/resources/built-in-index.json` | L1 内置索引（17 个 anthropics/skills） |
| `scripts/generate_index.py` | Python 索引生成脚本 |
| `scripts/skill-repos.json` | 已知 skill 仓库列表（3 个初始仓库） |
| `.github/workflows/update-market-index.yml` | GitHub Actions 工作流（每日 cron） |
| `deliverables/prd-market-route-c.md` | PRD 文档 |
| `deliverables/architecture-route-c.md` | 架构设计文档 |
| `deliverables/qa-report-market-route-c.md` | QA 审查报告 |

### 修改文件
| 文件 | 改动内容 |
|------|---------|
| `app/src-tauri/src/lib.rs` | 扩展 MarketEntry/MarketCandidate 结构体（+categories/hotness/author/license/version 等字段）；新增 `discover_builtin_index` 和 `refresh_remote_index` 命令；新增 `MarketIndexFile`/`MarketIndexEntry` 反序列化结构体；新增 `load_builtin_index()` 和 `fetch_remote_index()` 函数；更新 `browse_market_v2` 签名支持远程索引参数；更新 `sort_market` 支持 hotness 排序 |
| `app/src/types.ts` | 扩展 `MarketEntry` 接口（+categories/hotness/author/license/version/description/updatedAt/id） |
| `app/src/App.tsx` | 扩展 `AppSettings`（+remoteIndexUrl）；重构 `refreshMarket` 为 L1→L2→L3 三步加载；新增 `onDiscoverBuiltinIndex` prop；更新 `loadSettings` 处理新字段；更新 `marketSourceSignature` 包含新字段 |
| `app/src-tauri/tauri.conf.json` | 添加 `resources` 配置（打包 built-in-index.json） |

## QA 修复记录

| 问题 | 优先级 | 文件 | 修复 |
|------|--------|------|------|
| `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` 引用方式不正确 | 🔴 高 | `.github/workflows/update-market-index.yml:27` | 改为 `${{ github.token }}` |
| `updatedAt` 默认值为 `""` 而非 `None` | 🟡 中 | `scripts/generate_index.py:326` | 改为 `repo_info.get("updated_at")` |

## 用户下一步建议

1. **首次发布**：将改动 commit 并 push 到 GitHub，GitHub Actions 会自动在 UTC 06:00 生成远程索引
2. **手动触发**：在 GitHub Actions 页面手动触发 "Update Market Index" 工作流，立即生成 `gh-pages` 分支的 `index.json`
3. **配置 PAT（可选）**：如果 skill 仓库较多，在 GitHub Actions secrets 中配置 `GH_TOKEN` 为 PAT 以提高 API 限额
4. **扩展仓库列表**：编辑 `scripts/skill-repos.json` 添加更多 skill 仓库
5. **本地构建验证**：`cd app && npm run tauri dev` 启动应用，验证市场首屏秒开
