# Skill Hub

> 跨平台桌面应用，管理 Codex 与 Claude 的 skills 和 plugins

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue)
![Tauri](https://img.shields.io/badge/Tauri-2-orange)

[中文](README.md) · [English](README.en.md)

![Skill Hub 桌面应用预览](docs/images/skill-hub-preview.png)

## 目录

- [简介](#简介)
- [核心功能](#核心功能)
  - [资源管理](#资源管理)
  - [市场发现](#市场发现)
  - [安装与更新](#安装与更新)
  - [个性化](#个性化)
- [下载与安装](#下载与安装)
- [市场架构](#市场架构)
  - [排序方式](#排序方式)
- [扫描机制](#扫描机制)
- [GitHub 来源匹配](#github-来源匹配)
- [更新检测](#更新检测)
- [开发指南](#开发指南)
- [仓库结构](#仓库结构)
- [隐私说明](#隐私说明)
- [License](#license)

## 简介

Skill Hub 是一款基于 Tauri 2（Rust + React）构建的跨平台桌面应用，用于管理本地 Codex 与 Claude 的 skills 和 plugins，并从 GitHub 市场发现、安装新资源。它会扫描本地资源目录，判断每个资源的来源（官方、GitHub、本地），帮助你清晰区分不同来源的 skill。

## 核心功能

### 资源管理

- Codex 与 Claude 的 skills/plugins 资源库视图。
- 独立的 Skills、Plugins、市场（Market）、设置（Settings）分区。
- 来源分类：官方、GitHub、本地，支持按来源标签筛选并显示各视图数量。
- 详情面板展示摘要、来源 URL、更新状态、路径和兼容性。
- 支持手动添加额外的 skill 扫描路径。

### 市场发现

- 四层市场架构（L1 内置索引 → L2 远程索引 → L3 用户源 → L4 粘贴链接），开箱即有内容，逐层扩展发现范围。
- 市场顶部可在 **插件** 与 **Skill** 之间切换；"已添加"区域展示当前类型在本机已安装的资源总数与预览。
- 粘贴任意 GitHub 仓库或资源链接，即时发现并安装。
- 按热度（默认）、Star 数或名称排序，前三名带名次徽章。
- 市场预热与缓存：启动后后台预热，本地缓存 30 分钟，仅手动刷新时重新拉取。
- 刷新时显示 Rose Three 动态加载器，并逐个显示市场源加载状态。
- 市场结果分批渲染，避免一次性渲染导致卡顿。

### 安装与更新

- 从市场一键安装到 Codex 或 Claude，通过 HTTPS 下载并校验。
- 安装安全护栏：只接受公开 GitHub HTTPS/SSH URL，过滤敏感文件，写入限定在主机根目录内且不覆盖同名目标。
- 通过对比远程 `SKILL.md` 哈希检测 GitHub skill 更新，更新时旧副本移入废纸篓而非永久删除。
- 应用内更新检测：从 GitHub Releases 拉取 `latest.json` 安装已签名更新包。
- macOS 本地安装流程：直接替换 `/Applications/Skill-Hub.app`，无需每次通过 DMG 重装。

### 个性化

- 中英文界面语言设置。
- 深色与浅色主题。

## 下载与安装

前往 [GitHub Releases](https://github.com/JerryLiu-uestc/skill-hub/releases) 下载最新版本：

- **macOS**：下载 `.dmg` 或 `.app.tar.gz`，拖入 `/Applications` 即可使用。
- **Windows**：下载 `.msi` 或 `.exe` 安装包，双击运行安装。
- **Linux**：下载 `.AppImage` 或 `.deb`，按对应方式安装。

## 市场架构

Skill Hub 的市场采用四层架构，从离线可用到即时发现逐层递进。无论是否联网，应用首次打开就有内容。

| 层级 | 来源 | 速度 | 说明 |
|------|------|------|------|
| L1 内置索引 | 打包进 app | 0ms | 17 个官方 skill（全部来自 anthropics/skills），0 个 plugin，开箱即用，零网络请求 |
| L2 远程索引 | GitHub Actions 日报 | ~1s | 每天自动更新，通过 raw.githubusercontent.com 分发，无速率限制 |
| L3 用户源 | 用户添加的 GitHub 仓库 | ~3-5s | 通过 GitHub API 实时发现，可选配 Token 提升限额 |
| L4 粘贴链接 | 用户粘贴的 URL | 即时 | 粘贴任意 GitHub 链接，Skill Hub 变身为下载工具 |

**默认市场源（L3）。** 首次安装预置三个源：

- [`anthropics/skills`](https://github.com/anthropics/skills)
- [`obra/superpowers`](https://github.com/obra/superpowers)
- [`anthropics/claude-plugins-official`](https://github.com/anthropics/claude-plugins-official)

**L3 速率限制与可选 Token。** 匿名 GitHub API 一小时只有 60 次请求，发现功能很容易耗尽。在 **设置 → GitHub Token** 里填入个人访问令牌可把限额提升到 5000 次/小时。Token 仅保存在本地，除作为 GitHub API 调用的 `Authorization` 头外不会上传到任何地方。单个源失败（限速或网络问题）不会影响整个市场——其他源和内置索引仍会照常加载。

**L2 远程索引生成。** 仓库通过 GitHub Actions workflow（`.github/workflows/update-market-index.yml`）以 cron `0 6 * * *`（每天 UTC 06:00）自动生成 `index.json` 并发布到 gh-pages，应用通过 `raw.githubusercontent.com` 拉取，不占用 GitHub API 限额。

**L4 粘贴链接。** 在市场顶部的输入框粘贴任意 GitHub 仓库链接（`https://github.com/owner/repo`）或具体资源链接（`.../tree/<branch>/skills/<名称>`、`.../tree/<branch>/plugins/<名称>` 等），点击 **发现**，发现到的资源会并入市场，该仓库也会被记为源供下次刷新。需要新增长期市场源时，点击搜索框旁边的加号。

**市场加载与缓存。** 应用启动后在本地资源库开始加载后延迟进行后台预热。如果本地有有效缓存，市场直接使用缓存，不再请求 GitHub。缓存有效期 30 分钟，并按当前市场源列表区分。打开市场页不会触发刷新，只有点击 **刷新** 才会强制重新拉取。市场列表分批显示，刷新时显示 Rose Three 动态加载器和每个源的加载状态。

**发现与安装流程。** 发现一个仓库时，Skill Hub 调用一次 `git/trees?recursive=1` GitHub API 列出仓库里所有 `SKILL.md` 与插件 manifest 路径，每个资源的名称和描述走 `raw.githubusercontent.com` 读取（不限速），再调用一次仓库元数据接口附上 star 数。条目按仓库 URL 去重；本地资源在来源 URL、`SKILL.md` 哈希或名称匹配时标记为已安装。安装时通过 HTTPS 从 `codeload.github.com` 下载仓库 tarball，解压定位后拷贝到目标主机目录。

### 排序方式

市场支持三种排序：

- **热度（hotness，默认）**：`hotness = stars × 1.0 + recency_bonus`，其中 recency_bonus 按仓库更新时间衰减——7 天内 +100，30 天内 +50，90 天内 +20。这让近期活跃的优质仓库排在前面。
- **Star 数**：按来源仓库的 star 数排序。GitHub 没有 skill 粒度的指标，同一仓库下的多个 skill 共享该数字（star 上有 tooltip 说明）。
- **名称**：按字母排序。

前三名带名次徽章。

## 扫描机制

Skill Hub 默认扫描当前系统常见的 Codex/Claude 根目录，始终优先使用环境变量 `CODEX_HOME` 与 `CLAUDE_HOME`。

默认候选目录包括：

- `~/.codex/skills`、`~/.codex/plugins`
- `~/.claude/skills`、`~/.claude/plugins`
- macOS：`~/Library/Application Support/Codex`、`~/Library/Application Support/Claude`
- Windows：`%APPDATA%\Codex`、`%LOCALAPPDATA%\Codex`、`%APPDATA%\Claude`、`%LOCALAPPDATA%\Claude`
- Linux：`${XDG_CONFIG_HOME:-~/.config}/codex`、`${XDG_CONFIG_HOME:-~/.config}/claude`

你可以在设置里添加额外的 skill 根目录。包含 `SKILL.md` 的目录会被视为 skill；Codex 插件通过 `.codex-plugin/plugin.json` 识别，Claude 插件通过 `plugin.json` 识别。

来源分类判断顺序：

1. GitHub：`.git/config`、`SKILL.md` frontmatter，或匹配到的 GitHub 索引元数据。
2. 官方：Codex 系统 skill、内置插件内容，或整理过的插件缓存内容。
3. 本地：手动添加、自定义，或未匹配到 GitHub 来源的外部资源。

## GitHub 来源匹配

GitHub 匹配在设置里默认关闭，需手动开启。开启后，Skill Hub 会下载一个或多个公开索引 JSON 文件，并在本地与已安装的 skill 进行对比。本地 skill 文件和路径不会被上传。

索引可以是数组形式：

```json
[
  {
    "name": "ppt-master",
    "repository": "https://github.com/example/ppt-master",
    "description": "AI-driven multi-format SVG content generation system.",
    "skillSha256": "optional-sha256-of-SKILL.md"
  }
]
```

也可以包在 `skills` 字段里：

```json
{
  "skills": [
    {
      "name": "ppt-master",
      "repository": "https://github.com/example/ppt-master"
    }
  ]
}
```

匹配置信度：

- `GitHub verified`（已验证）：`SKILL.md` 的 SHA-256 与索引一致。
- `GitHub probable`（可能匹配）：名称与描述与索引一致。

## 更新检测

### Skill 更新

对任意来自 GitHub 的 skill，详情面板提供 **检查更新** 操作。Skill Hub 会抓取远程 `raw.githubusercontent.com/.../SKILL.md`（从来源 URL 解析分支与子路径，`main` 取不到时回退到 `master`），计算其哈希，再与本地 `SKILL.md` 对比：

- `已是最新`：本地与远程哈希一致。
- `有可用更新`：哈希不一致。
- `无法判断`：读取不到远程 `SKILL.md`。

当有可用更新时，**更新** 操作会先把新副本下载并校验到临时目录，再把现有 skill 移入系统废纸篓，然后安装新副本。如果下载或校验失败，已安装的 skill 保持原样不动；旧副本始终是移入废纸篓，而不会被永久删除。

### 应用更新

应用内的 **检查应用更新** 按钮会读取 GitHub Releases 中的 `latest.json`。构建发布包时，Tauri 会生成 updater tarball 和签名文件；随后运行：

```bash
cd app
npm run release:latest-json
```

脚本会根据当前 `tauri.conf.json` 版本和 updater 签名生成 `latest.json`。在单机本地构建时读取当前平台的 updater 产物；在 GitHub Actions 发布流程中合并 Windows、Linux 和 macOS 产物，生成包含多个 `platforms` 条目的统一 `latest.json`。

## 开发指南

### 环境要求

- Node.js
- Rust
- Windows 打包需要 Windows runner，Linux 打包需要 Linux runner，macOS 打包需要 macOS runner。仓库内置的 GitHub Actions release workflow 会在对应系统上分别构建。

### 安装依赖

```bash
cd app
npm install
```

### 开发命令

启动 Vite 开发服务器（在 `http://127.0.0.1:1420/` 启动浏览器开发版界面，不会更新已安装到 `/Applications` 的 macOS App）：

```bash
npm run dev
```

运行检查：

```bash
npm run test
npm run lint
npm run format:check
cd src-tauri && cargo test
```

### 构建

构建应用 bundle：

```bash
npm run build:app
```

在 macOS 上把最新的本地构建安装到 `/Applications`：

```bash
npm run install:local
```

只要希望已安装的桌面应用（`/Applications/Skill-Hub.app`）反映本地代码改动，就要运行这个命令。脚本会构建 Tauri bundle，退出当前正在运行的 Skill Hub，替换 `/Applications/Skill-Hub.app`，尽量清除 quarantine 元数据，然后重新打开应用。如果 `http://127.0.0.1:1420/` 里的浏览器页面已经变了但桌面 App 没变，说明看到的是两个不同运行入口——运行 `npm run install:local` 并重新打开桌面 App。

构建桌面发布产物：

```bash
npm run build:desktop
```

本地构建脚本是跨平台的，会从 `TAURI_SIGNING_PRIVATE_KEY` 读取 updater 签名私钥；如果未设置，则尝试读取 `TAURI_SIGNING_PRIVATE_KEY_PATH`，默认是 `~/.skill-hub/updater.key`。

### 发布

仓库包含 `.github/workflows/release.yml`。推送版本 tag（例如 `v0.4.0`）或手动触发 workflow 后，CI 会：

1. 在 Ubuntu、Windows 和 macOS runner 上分别执行 Tauri 构建。
2. 上传各平台安装包、updater 包和 `.sig` 签名文件。
3. 合并所有 `.sig` 文件生成统一的 `latest.json`。
4. 发布到同一个 GitHub Release。

需要在仓库 Secrets 中配置：

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（如果私钥设置了密码）

手动创建 release：

```bash
git tag v0.4.0
git push origin v0.4.0
```

## 仓库结构

- `app/src`：React 界面。
- `app/src-tauri/src`：负责扫描、来源匹配、安装与删除的 Tauri/Rust 后端。
- `app/scripts`：本地安装与 DMG 后处理脚本。
- `app/src/*.test.tsx` 与 `app/src/*.test.ts`：前端测试。
- `app/src-tauri/src/lib.rs`：后端逻辑与 Rust 测试。

## 隐私说明

GitHub 匹配默认关闭。开启后，应用会下载已配置的索引 URL 并在本地完成匹配。它不会上传本地 skill 目录、文件内容或路径。GitHub Token 仅保存在本地，除作为 API 调用的 `Authorization` 头外不会上传到任何地方。

## License

本项目基于 [MIT License](LICENSE) 开源，版权所有 2025-2026 JerryLiu-uestc。
