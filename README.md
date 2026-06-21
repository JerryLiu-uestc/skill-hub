# Skill Hub

Skill Hub is a macOS desktop app for managing local Codex and Claude skills and plugins. It scans local resource folders, classifies where each resource came from, and helps distinguish native, registry, linked, local, and GitHub-backed skills.

## Features

- Inventory view for Codex and Claude skills/plugins.
- Separate Skills, Plugins, Sources, and Settings sections.
- Source classification: Native, GitHub, Local, Registry, and Linked.
- Source tag filtering with per-view counts.
- GitHub source matching against configurable public index JSON files.
- Details panel with summary, source URL, update status, path, compatibility, and warnings.
- Manual extra skill path scanning.
- Language setting for English and Chinese.
- Dark and light themes.
- Local install workflow that replaces `/Applications/Skill Hub.app` without reinstalling through a DMG each iteration.

## How Scanning Works

Skill Hub scans these default roots:

- `~/.codex/skills`
- `~/.codex/plugins`
- `~/.claude/skills`
- `~/.claude/plugins`

You can add extra skill roots in Settings. A directory is treated as a skill when it contains `SKILL.md`. A Codex plugin is detected by `.codex-plugin/plugin.json`; a Claude plugin is detected by `plugin.json`.

Source classification uses this order:

1. GitHub: `.git/config`, `SKILL.md` frontmatter, or matched GitHub index metadata.
2. Native: Codex system skills or OpenAI bundled plugin content.
3. Registry: OpenAI curated/remote plugin cache content.
4. Linked: symlinked resources outside the scanned root.
5. Local: anything else.

## GitHub Source Matching

GitHub matching is opt-in from Settings. When enabled, Skill Hub downloads one or more public index JSON files and compares them locally against installed skills. Local skill files and paths are not uploaded.

An index can be an array:

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

Or wrapped in a `skills` field:

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

Matching confidence:

- `GitHub verified`: `SKILL.md` SHA-256 matches the index.
- `GitHub probable`: name and description match the index.

## Development

Prerequisites:

- Node.js
- Rust
- macOS for Tauri app packaging

Install dependencies:

```bash
cd app
npm install
```

Run the Vite development server:

```bash
npm run dev
```

Run checks:

```bash
npm run test
npm run lint
npm run format:check
cd src-tauri && cargo test
```

Build the app bundle:

```bash
npm run build:app
```

Install the latest local build into `/Applications`:

```bash
npm run install:local
```

Build the desktop release artifacts:

```bash
npm run build:desktop
```

## Repository Layout

- `app/src`: React UI.
- `app/src-tauri/src`: Tauri/Rust backend for scanning, source matching, installs, and deletion.
- `app/scripts`: local install and DMG post-processing scripts.
- `app/src/*.test.tsx` and `app/src/*.test.ts`: frontend tests.
- `app/src-tauri/src/lib.rs`: backend logic and Rust tests.

## Privacy Notes

GitHub matching is disabled by default. When enabled, the app downloads configured index URLs and performs matching locally. It does not upload local skill directories, file contents, or paths.
