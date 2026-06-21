import { describe, expect, it } from "vitest";
import { filterInventory } from "./inventory";
import type { SkillResource } from "./types";

const resources: SkillResource[] = [
  {
    id: "codex-skill-review",
    name: "Code Review",
    kind: "skill",
    host: "codex",
    status: "ready",
    path: "/tmp/codex/skills/code-review",
    summary: "Review pull requests",
    compatibility: ["codex"],
    warnings: [],
    sourceKind: "native",
    sourceUrl: null,
    updateStatus: "Managed",
  },
  {
    id: "claude-plugin-deploy",
    name: "Deploy Plugin",
    kind: "plugin",
    host: "claude",
    status: "warning",
    path: "/tmp/claude/plugins/deploy",
    summary: "Ship releases",
    compatibility: ["claude"],
    warnings: ["Missing README"],
    sourceKind: "github",
    sourceUrl: "https://github.com/acme/deploy",
    updateStatus: "Trackable",
  },
  {
    id: "codex-plugin-notes",
    name: "Notes Plugin",
    kind: "plugin",
    host: "codex",
    status: "ready",
    path: "/tmp/codex/plugins/notes",
    summary: "Capture durable notes",
    compatibility: ["codex", "claude"],
    warnings: [],
    sourceKind: "local",
    sourceUrl: null,
    updateStatus: "Manual",
  },
];

describe("filterInventory", () => {
  it("composes kind, host, and free text filters", () => {
    const result = filterInventory(resources, {
      kind: "plugin",
      host: "codex",
      source: "all",
      query: "durable",
    });

    expect(result.map((resource) => resource.id)).toEqual(["codex-plugin-notes"]);
  });

  it("matches text across name, summary, path, and warnings", () => {
    const result = filterInventory(resources, {
      kind: "all",
      host: "all",
      source: "all",
      query: "missing",
    });

    expect(result.map((resource) => resource.id)).toEqual(["claude-plugin-deploy"]);
  });

  it("filters by source kind before applying free text search", () => {
    const result = filterInventory(resources, {
      kind: "all",
      host: "all",
      source: "github",
      query: "plugin",
    });

    expect(result.map((resource) => resource.id)).toEqual(["claude-plugin-deploy"]);
  });
});
