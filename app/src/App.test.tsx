import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { MarketEntry, MarketResult, SkillResource, UpdateCheck } from "./types";

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
  {
    id: "codex-plugin-registry",
    name: "Curated Plugin",
    kind: "plugin",
    host: "codex",
    status: "ready",
    path: "/tmp/codex/plugins/cache/openai-curated-remote/registry-plugin",
    summary: "Curated plugin",
    compatibility: ["codex"],
    warnings: [],
    sourceKind: "registry",
    sourceUrl: null,
    updateStatus: "Registry",
  },
];

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function marketEntry(overrides: Partial<MarketEntry> & Pick<MarketEntry, "name" | "sourceUrl">): MarketEntry {
  return {
    kind: "skill",
    summary: null,
    skillSha256: null,
    installed: false,
    installedId: null,
    repo: null,
    stars: null,
    origin: "community",
    ...overrides,
  };
}

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

  it("keeps Market as the only discovery and install navigation entry", () => {
    render(<App initialResources={inventory} />);

    expect(screen.getByRole("button", { name: "Market" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sources" })).not.toBeInTheDocument();
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

  it("only highlights the active sidebar navigation item", () => {
    render(<App initialResources={inventory} />);

    expect(screen.getByRole("button", { name: "Overview" }).querySelector("svg")).toHaveClass("opacity-100");
    expect(screen.getByRole("button", { name: "Settings" }).querySelector("svg")).toHaveClass("opacity-40");

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(screen.getByRole("button", { name: "Overview" }).querySelector("svg")).toHaveClass("opacity-40");
    expect(screen.getByRole("button", { name: "Settings" }).querySelector("svg")).toHaveClass("opacity-100");
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

  it("seeds the official Claude plugin repository as a default market source", () => {
    render(<App initialResources={inventory} />);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(screen.getByText("https://github.com/anthropics/claude-plugins-official")).toBeInTheDocument();
  });

  it("migrates an older empty market source setting back to built-in defaults", () => {
    window.localStorage.setItem(
      "skillHubSettings",
      JSON.stringify({ language: "en", theme: "dark", marketSources: [] }),
    );

    render(<App initialResources={inventory} />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(screen.getByText("https://github.com/anthropics/claude-plugins-official")).toBeInTheDocument();
  });

  it("localizes the main inventory view when Chinese is selected", () => {
    render(<App initialResources={inventory} />);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.change(screen.getByLabelText("Language"), { target: { value: "zh" } });
    fireEvent.click(screen.getByRole("button", { name: "总览" }));

    expect(screen.getByRole("heading", { name: "资源库" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("搜索资源")).toBeInTheDocument();
    expect(screen.getAllByText("GitHub").length).toBeGreaterThan(0);
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

    fireEvent.click(screen.getByRole("button", { name: /^Official\s+3$/i }));

    expect(screen.queryByRole("button", { name: /code review/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /native skill/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /curated plugin/i })).toBeInTheDocument();
  });

  it("filters the resource list by search text", () => {
    render(<App initialResources={inventory} />);

    fireEvent.change(screen.getByLabelText("Search resources"), { target: { value: "browser" } });

    expect(screen.getByRole("button", { name: /browser/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /code review/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /native skill/i })).not.toBeInTheDocument();
  });

  it("switches resource results between list and card views", () => {
    render(<App initialResources={inventory} />);

    expect(screen.getByText("Resource")).toBeInTheDocument();

    const viewMode = screen.getByRole("group", { name: "View mode" });
    fireEvent.click(within(viewMode).getByRole("button", { name: "Grid view" }));

    expect(screen.queryByText("Resource")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /code review/i })).toBeInTheDocument();

    fireEvent.click(within(viewMode).getByRole("button", { name: "List view" }));

    expect(screen.getByText("Resource")).toBeInTheDocument();
  });

  it("scopes source tags and selected details to the active resource kind view", () => {
    render(<App initialResources={inventory} />);

    fireEvent.click(screen.getByRole("button", { name: "Plugins" }));

    expect(screen.getByRole("button", { name: "All 2" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Official 2" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /browser/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /curated plugin/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /code review/i })).not.toBeInTheDocument();

    const details = screen.getByLabelText("Resource details");
    expect(within(details).getByRole("heading", { name: "Browser" })).toBeInTheDocument();
    expect(within(details).getByText("Official Plugin")).toBeInTheDocument();
  });

  it("renders the market directory and installs a non-installed entry through the callback", async () => {
    const market: MarketEntry[] = [
      marketEntry({ name: "ppt-master", summary: "Make presentations", sourceUrl: "https://github.com/acme/ppt-master" }),
      marketEntry({
        name: "already-here",
        summary: "Existing skill",
        sourceUrl: "https://github.com/acme/already-here",
        installed: true,
        installedId: "codex-skill-already-here",
      }),
    ];
    const onInstallMarket = vi.fn().mockResolvedValue(undefined);
    render(
      <App initialResources={inventory} initialMarket={market} onInstallMarket={onInstallMarket} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Market" }));
    fireEvent.click(screen.getByRole("tab", { name: "Skill" }));

    expect(screen.getByRole("heading", { name: "ppt-master" })).toBeInTheDocument();
    expect(screen.getByLabelText("Code Review")).toBeInTheDocument();
    expect(screen.getByLabelText("Native Skill")).toBeInTheDocument();

    const freshCard = screen.getByRole("heading", { name: "ppt-master" }).closest("article");
    fireEvent.click(within(freshCard as HTMLElement).getByRole("button", { name: "Install" }));

    expect(onInstallMarket).toHaveBeenCalledWith(market[0], "codex");
  });

  it("filters market entries by search query", () => {
    const market: MarketEntry[] = [
      marketEntry({ name: "ppt-master", summary: "Make presentations", sourceUrl: "https://github.com/acme/ppt-master" }),
      marketEntry({ name: "code-review", summary: "Review pull requests", sourceUrl: "https://github.com/acme/code-review" }),
    ];
    render(<App initialResources={inventory} initialMarket={market} />);

    fireEvent.click(screen.getByRole("button", { name: "Market" }));
    fireEvent.click(screen.getByRole("tab", { name: "Skill" }));
    fireEvent.change(screen.getByLabelText("Search market or paste a GitHub URL"), { target: { value: "presentations" } });

    expect(screen.getByRole("heading", { name: "ppt-master" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "code-review" })).not.toBeInTheDocument();
  });

  it("filters market entries by skill or plugin type", () => {
    const market: MarketEntry[] = [
      marketEntry({ name: "ppt-master", kind: "skill", sourceUrl: "https://github.com/acme/ppt-master" }),
      marketEntry({ name: "github-plugin", kind: "plugin", sourceUrl: "https://github.com/acme/github-plugin" }),
    ];
    render(<App initialResources={inventory} initialMarket={market} />);

    fireEvent.click(screen.getByRole("button", { name: "Market" }));
    expect(screen.getByRole("heading", { name: "ppt-master" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "github-plugin" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Plugin" }));

    expect(screen.queryByRole("heading", { name: "ppt-master" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "github-plugin" })).toBeInTheDocument();
  });

  it("uses top tabs to switch the market directory between plugins and skills", () => {
    const market: MarketEntry[] = [
      marketEntry({ name: "ppt-master", sourceUrl: "https://github.com/acme/ppt-master" }),
      marketEntry({ name: "github-plugin", kind: "plugin", sourceUrl: "https://github.com/acme/github-plugin" }),
    ];
    render(<App initialResources={inventory} initialMarket={market} />);

    fireEvent.click(screen.getByRole("button", { name: "Market" }));

    expect(screen.getByRole("tab", { name: "Skill" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "ppt-master" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Plugin" }));
    expect(screen.getByRole("tab", { name: "Plugin" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "github-plugin" })).toBeInTheDocument();
  });

  it("checks for updates on a GitHub skill and surfaces the result", async () => {
    const onCheckUpdate = vi.fn(
      (): Promise<UpdateCheck> =>
        Promise.resolve({
          status: "update-available",
          sourceUrl: "https://github.com/acme/code-review",
          localSha256: "aaa",
          remoteSha256: "bbb",
          detail: null,
        }),
    );
    render(<App initialResources={inventory} onCheckUpdate={onCheckUpdate} />);

    fireEvent.click(screen.getByRole("button", { name: /code review/i }));
    const details = screen.getByLabelText("Resource details");
    fireEvent.click(within(details).getByRole("button", { name: "Check for updates" }));

    expect(onCheckUpdate).toHaveBeenCalled();
    expect(await within(details).findByText("Update available")).toBeInTheDocument();
  });

  it("does not show the update check on non-GitHub resources", () => {
    render(<App initialResources={inventory} />);

    fireEvent.click(screen.getByRole("button", { name: /native skill/i }));
    const details = screen.getByLabelText("Resource details");

    expect(within(details).queryByRole("button", { name: "Check for updates" })).not.toBeInTheDocument();
  });

  it("discovers skills from a pasted GitHub URL and merges them into the market", async () => {
    const onDiscoverRepo = vi.fn(
      (): Promise<MarketEntry[]> =>
        Promise.resolve([
          marketEntry({
            name: "discovered-skill",
            summary: "From a pasted repo",
            sourceUrl: "https://github.com/someone/repo/tree/main/skills/discovered-skill",
            repo: "someone/repo",
            stars: 42,
          }),
        ]),
    );
    render(<App initialResources={inventory} initialMarket={[]} onDiscoverRepo={onDiscoverRepo} />);

    fireEvent.click(screen.getByRole("button", { name: "Market" }));
    fireEvent.change(screen.getByLabelText("Search market or paste a GitHub URL"), {
      target: { value: "https://github.com/someone/repo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Discover" }));

    expect(onDiscoverRepo).toHaveBeenCalledWith("https://github.com/someone/repo");
    expect(await screen.findByRole("heading", { name: "discovered-skill" })).toBeInTheDocument();
  });

  it("does not save a discovered GitHub URL as a market source", async () => {
    const onDiscoverRepo = vi.fn(
      (): Promise<MarketEntry[]> =>
        Promise.resolve([
          marketEntry({
            name: "temporary-find",
            sourceUrl: "https://github.com/someone/repo/tree/main/skills/temporary-find",
          }),
        ]),
    );
    render(<App initialResources={inventory} initialMarket={[]} onDiscoverRepo={onDiscoverRepo} />);

    fireEvent.click(screen.getByRole("button", { name: "Market" }));
    fireEvent.change(screen.getByLabelText("Search market or paste a GitHub URL"), {
      target: { value: "https://github.com/someone/repo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Discover" }));

    expect(await screen.findByRole("heading", { name: "temporary-find" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(screen.queryByText("https://github.com/someone/repo")).not.toBeInTheDocument();
  });

  it("adds a market source from the plus button beside market search", () => {
    render(<App initialResources={inventory} initialMarket={[]} />);

    fireEvent.click(screen.getByRole("button", { name: "Market" }));
    fireEvent.click(screen.getByRole("button", { name: "Add market source" }));
    fireEvent.change(screen.getByLabelText("Market source URL"), {
      target: { value: "https://github.com/someone/repo" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Add market source" })[1]);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(screen.getByText("https://github.com/someone/repo")).toBeInTheDocument();
  });

  it("renders the Rose Three loader while the market refresh is pending", async () => {
    const pendingMarket = new Promise<MarketResult>(() => {});
    render(
      <App
        initialResources={inventory}
        onDiscoverCuratedCatalog={() => pendingMarket}
        onDiscoverMarketSource={() => pendingMarket}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Market" }));
    fireEvent.click(within(screen.getByRole("region", { name: "Market" })).getByRole("button", { name: "Refresh" }));

    const loader = await screen.findByRole("img", { name: "Rose Three loading animation" });
    expect(loader.querySelectorAll(".rose-loader-particle")).toHaveLength(76);
    expect(loader.querySelector("style")?.textContent).toContain("@keyframes rose-three-particle");
  });

  it("sorts the market as a leaderboard by stars", () => {
    const market: MarketEntry[] = [
      marketEntry({ name: "low-star", sourceUrl: "https://github.com/a/low", stars: 5 }),
      marketEntry({ name: "high-star", sourceUrl: "https://github.com/a/high", stars: 9000 }),
    ];
    render(<App initialResources={inventory} initialMarket={market} />);

    fireEvent.click(screen.getByRole("button", { name: "Market" }));
    fireEvent.click(screen.getByRole("tab", { name: "Skill" }));

    const headings = screen.getAllByRole("heading", { level: 4 }).map((node) => node.textContent);
    // Highest stars first.
    expect(headings[0]).toBe("high-star");
    expect(screen.getByText("★ 9.0k")).toBeInTheDocument();
  });

  it("stores an optional GitHub token in settings", () => {
    render(<App initialResources={inventory} />);

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.change(screen.getByLabelText("GitHub token (optional)"), {
      target: { value: "ghp_secret123" },
    });

    expect(screen.getByLabelText("GitHub token (optional)")).toHaveValue("ghp_secret123");
  });
});
