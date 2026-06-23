# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository shape

This `main` branch tracks **only the design spec** ([docs/superpowers/specs/2026-06-21-skill-hub-design.md](docs/superpowers/specs/2026-06-21-skill-hub-design.md), written in Chinese). The implementation deliberately lives **outside source control** — it sits in a git worktree at `.worktrees/skill-hub-mvp/` (branch `codex/skill-hub-mvp`), and `.worktrees/`, `.omx/`, and `.superpowers/` are all gitignored. Commit `a250217` ("Keep local implementation workspaces out of source control") is intentional.

To work on the actual app, operate inside `.worktrees/skill-hub-mvp/app/`. Treat the spec on `main` as the source of truth for *intended* behavior and the worktree as the live code. The worktree's own [README](.worktrees/skill-hub-mvp/README.md) documents user-facing features.

## Commands

All commands run from `.worktrees/skill-hub-mvp/app/`:

```bash
npm install              # install JS deps (Node + Rust + macOS required)
npm run dev              # Vite dev server (frontend only, no Tauri backend)
npm run test             # vitest run — frontend tests
npm run lint             # tsc --noEmit (typecheck; same as `npm run typecheck`)
npm run format:check     # cargo fmt --check on the Rust backend
cd src-tauri && cargo test   # Rust backend tests (the core logic lives here)
cd src-tauri && cargo test <name>   # run a single Rust test by name

npm run build            # tsc && vite build (frontend bundle)
npm run build:app        # tauri build --bundles app (macOS .app)
npm run install:local    # build:app then replace /Applications/Skill Hub.app in place
npm run build:desktop    # full tauri build + DMG repack
```

There is no aggregate "run all checks" script — run `npm run test`, `npm run lint`, `npm run format:check`, and `cargo test` separately.

## Architecture

Tauri 2 desktop app: **React 19 + TypeScript frontend** over a **Rust backend**, communicating via Tauri `invoke` commands. The backend holds essentially all the logic; the frontend is a thin shell.

- **Backend — [app/src-tauri/src/lib.rs](.worktrees/skill-hub-mvp/app/src-tauri/src/lib.rs)** is the whole service layer (scanning, source classification, GitHub index matching, install preview/copy, trash). It exposes five `#[tauri::command]`s: `scan_inventory`, `match_github_sources`, `preview_source`, `install_resource`, `delete_resource`. Rust unit tests live in the same file under `#[cfg(test)]` and are the primary test suite. `main.rs` just calls `run()`.
- **Frontend — [app/src/App.tsx](.worktrees/skill-hub-mvp/app/src/App.tsx)** is a single component holding all nav (Overview / Skills / Plugins / Sources / Settings), state, and `invoke` calls. [inventory.ts](.worktrees/skill-hub-mvp/app/src/inventory.ts) is pure filter logic; [types.ts](.worktrees/skill-hub-mvp/app/src/types.ts) mirrors the Rust serde structs (note `#[serde(rename_all = "camelCase")]` — Rust `source_kind` ⇄ TS `sourceKind`).

### Domain model

A scan produces `SkillResource` records keyed by `host` (codex | claude), `kind` (skill | plugin | unknown), and `name`. Default scan roots are `~/.codex/{skills,plugins}` and `~/.claude/{skills,plugins}` (overridable via `CODEX_HOME` / `CLAUDE_HOME` env vars or command args). Detection rules: a directory is a **skill** if it contains `SKILL.md`; a **Codex plugin** needs `.codex-plugin/plugin.json`; a **Claude plugin** needs `plugin.json`. `SourceKind` (Native / GitHub / Local / Linked / Registry) is derived by `source_kind_for`.

### Non-negotiable invariants (enforced in the backend, asserted by tests)

These come from the spec's security model — preserve them when editing `lib.rs`:

- **Never read, surface, copy, or log sensitive files.** `is_sensitive_path` skips `.env`, `*.pem`, `*.key`, and anything containing `token`/`secret`/`credential` during scan, copy, and warnings. Warnings must never contain a sensitive filename.
- **All writes/installs are confined to the host root.** `assert_inside` / `assert_inside_nonexistent` gate every target path; installs go only to `<root>/skills/<name>` or `<root>/plugins/<name>`.
- **No overwrites.** Install fails with `NameConflict` if the target exists — the MVP never overwrites implicitly.
- **Deletes go to the system trash only** (`SystemTrash` → `~/.Trash`), never a permanent `fs::remove`, and never a fallback delete on trash failure.
- **Only public GitHub HTTPS/SSH URLs** are accepted as install sources (`validate_github_source`); `file:`/local/relative sources are rejected. Network GitHub install is **preview-only** in this MVP — `install_from_preview` requires a local `source_path`.
- **GitHub index matching is opt-in and local-only**: it downloads configured index JSON over HTTPS and matches against installed skills locally (`skill_sha256` → "verified", name+summary → "probable"); it never uploads local paths or contents.

When you change a backend behavior, add or update the corresponding `#[cfg(test)]` test in `lib.rs` — the existing tests encode these invariants and are the regression net.
