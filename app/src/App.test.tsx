import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { SkillResource } from "./types";

const inventory: SkillResource[] = [
  {
    id: "codex-skill-review",
    name: "Code Review",
    kind: "skill",
    host: "codex",
    status: "ready",
    path: "/tmp/codex/skills/code-review",
    summary: "Review pull requests",
    compatibility: ["codex", "claude"],
    warnings: [],
    sourceKind: "github",
    sourceUrl: "https://github.com/acme/code-review",
    updateStatus: "Trackable",
  },
  {
    id: "codex-skill-native",
    name: "Native Skill",
    kind: "skill",
    host: "codex",
    status: "ready",
    path: "/tmp/codex/skills/.system/native-skill",
    summary: "Bundled skill",
    compatibility: ["codex"],
    warnings: [],
    sourceKind: "native",
    sourceUrl: null,
    updateStatus: "Managed",
  },
  {
    id: "codex-plugin-browser",
    name: "Browser",
    kind: "plugin",
    host: "codex",
    status: "ready",
    path: "/tmp/codex/plugins/cache/openai-bundled/browser/26.616.51431",
    summary: "Control the in-app browser",
    compatibility: ["codex"],
    warnings: [],
    sourceKind: "native",
    sourceUrl: null,
    updateStatus: "Managed",
  },
];

afterEach(() => {
  cleanup();
});

describe("App", () => {
  it("opens a details drawer with path and compatibility when a row is selected", () => {
    render(<App initialResources={inventory} />);

    fireEvent.click(screen.getByRole("button", { name: /code review/i }));

    const details = screen.getByLabelText("Resource details");
    expect(within(details).getByRole("heading", { name: "Code Review" })).toBeInTheDocument();
    expect(within(details).getByText("/tmp/codex/skills/code-review")).toBeInTheDocument();
    expect(within(details).getByText("Codex, Claude")).toBeInTheDocument();
    expect(within(details).getByText("Review pull requests")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /expand/i })).toBeInTheDocument();
  });

  it("requires deletion confirmation before invoking delete", () => {
    const onDelete = vi.fn();
    render(<App initialResources={inventory} onDeleteResource={onDelete} />);

    fireEvent.click(screen.getByRole("button", { name: /code review/i }));
    fireEvent.click(screen.getByRole("button", { name: /delete/i }));

    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /confirm delete/i }));

    expect(onDelete).toHaveBeenCalledWith("/tmp/codex/skills/code-review");
  });

  it("does not expose install before preview succeeds", () => {
    render(<App initialResources={inventory} />);

    fireEvent.click(screen.getByRole("button", { name: "Sources" }));

    expect(screen.queryByRole("button", { name: /install/i })).not.toBeInTheDocument();
  });

  it("opens settings and stores extra skill paths in the panel", () => {
    render(<App initialResources={inventory} />);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.change(screen.getByLabelText("Language"), { target: { value: "zh" } });

    expect(screen.getByRole("heading", { name: "设置" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Skill 路径"), { target: { value: "~/custom/skills" } });
    fireEvent.click(screen.getByRole("button", { name: "添加路径" }));

    expect(screen.getByText("~/custom/skills")).toBeInTheDocument();
  });

  it("configures GitHub index matching from settings", () => {
    render(<App initialResources={inventory} />);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByLabelText("Enable online matching"));
    fireEvent.change(screen.getByLabelText("GitHub index URL"), {
      target: { value: "https://raw.githubusercontent.com/acme/skills/main/skills-index.json" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add index" }));

    expect(screen.getByText("https://raw.githubusercontent.com/acme/skills/main/skills-index.json")).toBeInTheDocument();
  });

  it("localizes the main inventory view when Chinese is selected", () => {
    render(<App initialResources={inventory} />);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.change(screen.getByLabelText("Language"), { target: { value: "zh" } });
    fireEvent.click(screen.getByRole("button", { name: "总览" }));

    expect(screen.getByRole("heading", { name: "资源库" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("搜索资源")).toBeInTheDocument();
    expect(screen.getByText("GitHub 跟踪")).toBeInTheDocument();
    expect(screen.getByText("全部类型")).toBeInTheDocument();
    expect(screen.getByText("资源")).toBeInTheDocument();
    expect(screen.getByText("摘要")).toBeInTheDocument();
    expect(screen.getByText("更新状态")).toBeInTheDocument();
  });

  it("filters resources by source tag", () => {
    render(<App initialResources={inventory} />);

    fireEvent.click(screen.getByRole("button", { name: /^GitHub\s+1$/i }));

    expect(screen.getByRole("button", { name: /code review/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /native skill/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Native\s+2$/i }));

    expect(screen.queryByRole("button", { name: /code review/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /native skill/i })).toBeInTheDocument();
  });

  it("scopes source tags and selected details to the active resource kind view", () => {
    render(<App initialResources={inventory} />);

    fireEvent.click(screen.getByRole("button", { name: "Plugins" }));

    expect(screen.getByRole("button", { name: "All 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Native 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /browser/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /code review/i })).not.toBeInTheDocument();

    const details = screen.getByLabelText("Resource details");
    expect(within(details).getByRole("heading", { name: "Browser" })).toBeInTheDocument();
    expect(within(details).getByText("Native Plugin")).toBeInTheDocument();
  });
});
