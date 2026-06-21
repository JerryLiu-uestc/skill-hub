import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { filterInventory } from "./inventory";
import type { GitHubSourceMatch, HostKind, InventoryFilters, ResourceKind, SkillResource, SourceKind } from "./types";
import "./App.css";

type NavItem = "overview" | "skills" | "plugins" | "sources" | "settings";
type Language = "en" | "zh";
type Theme = "dark" | "light";

interface AppSettings {
  language: Language;
  theme: Theme;
  extraSkillPaths: string[];
  githubMatchingEnabled: boolean;
  githubIndexUrls: string[];
}

interface InstallPreview {
  source: string;
  host: HostKind;
  kind: ResourceKind;
  name: string;
  targetPath: string;
  warnings: string[];
}

interface AppProps {
  initialResources?: SkillResource[];
  onDeleteResource?: (path: string) => void | Promise<void>;
}

function App({ initialResources, onDeleteResource }: AppProps) {
  const [activeNav, setActiveNav] = useState<NavItem>("overview");
  const [resources, setResources] = useState<SkillResource[]>(initialResources ?? []);
  const [selectedId, setSelectedId] = useState<string | null>(initialResources?.[0]?.id ?? null);
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [newSkillPath, setNewSkillPath] = useState("");
  const [newIndexUrl, setNewIndexUrl] = useState("");
  const [filters, setFilters] = useState<InventoryFilters>({
    kind: "all",
    host: "all",
    source: "all",
    query: "",
  });
  const [pendingDelete, setPendingDelete] = useState(false);
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [sourceHost, setSourceHost] = useState<HostKind>("codex");
  const [sourceKind, setSourceKind] = useState<ResourceKind>("skill");
  const [preview, setPreview] = useState<InstallPreview | null>(null);
  const [notice, setNotice] = useState(initialResources ? "Fixture inventory loaded." : "Scanning local skill roots...");

  useEffect(() => {
    if (!initialResources) {
      refreshInventory();
    }
  }, [initialResources, settings.extraSkillPaths]);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
    saveSettings(settings);
    setNotice((current) => translateKnownNotice(current, settings.language));
  }, [settings]);

  const scopedResources = useMemo(
    () => filterInventory(resources, { ...filters, source: "all" }).filter((resource) => {
      if (activeNav === "skills") return resource.kind === "skill";
      if (activeNav === "plugins") return resource.kind === "plugin";
      return activeNav !== "sources" && activeNav !== "settings";
    }),
    [activeNav, filters, resources],
  );

  const visibleResources = useMemo(
    () =>
      filters.source === "all"
        ? scopedResources
        : scopedResources.filter((resource) => resource.sourceKind === filters.source),
    [filters.source, scopedResources],
  );

  const selected = visibleResources.find((resource) => resource.id === selectedId) ?? visibleResources[0];
  const skillCount = resources.filter((resource) => resource.kind === "skill").length;
  const pluginCount = resources.filter((resource) => resource.kind === "plugin").length;
  const githubCount = resources.filter((resource) => resource.sourceKind === "github").length;
  const warningCount = resources.filter((resource) => resource.warnings.length > 0).length;
  const linkedCount = resources.filter((resource) => resource.sourceKind === "linked").length;

  async function refreshInventory() {
    try {
      const scanned = await invoke<SkillResource[]>("scan_inventory", {
        codexRoot: null,
        claudeRoot: null,
        extraSkillPaths: settings.extraSkillPaths,
      });
      const matched = await enrichWithGithubMatches(scanned);
      setResources(matched);
      setSelectedId(matched[0]?.id ?? null);
      setNotice(matched.length ? labels[settings.language].inventoryRefreshed : labels[settings.language].noRoots);
    } catch (error) {
      setResources([]);
      setSelectedId(null);
      setNotice(String(error));
    }
  }

  async function previewSource() {
    setPreview(null);
    if (!sourceUrl.trim() || !sourceName.trim()) {
      setNotice(text.sourceRequired);
      return;
    }
    try {
      const result = await invoke<InstallPreview>("preview_source", {
        source: sourceUrl,
        host: sourceHost,
        root: sourceHost === "codex" ? "~/.codex" : "~/.claude",
        kind: sourceKind,
        name: sourceName,
      });
      setPreview(result);
      setNotice(text.previewReady);
    } catch (error) {
      setNotice(String(error));
    }
  }

  async function installPreview() {
    if (!preview) return;
    try {
      await invoke("install_resource", { preview });
      setNotice(`${preview.name} ${text.installed}`);
      setPreview(null);
    } catch (error) {
      setNotice(String(error));
    }
  }

  async function deleteSelected() {
    if (!selected) return;
    if (!pendingDelete) {
      setPendingDelete(true);
      return;
    }
    if (onDeleteResource) {
      await onDeleteResource(selected.path);
    } else {
      await invoke("delete_resource", {
        path: selected.path,
        root: rootFromResourcePath(selected.path),
      });
    }
    setResources((current) => current.filter((resource) => resource.id !== selected.id));
    setSelectedId(null);
    setPendingDelete(false);
    setNotice(`${selected.name} ${text.movedToTrash}`);
  }

  function addExtraSkillPath() {
    const path = newSkillPath.trim();
    if (!path) {
      setNotice(text.skillPathRequired);
      return;
    }
    if (settings.extraSkillPaths.includes(path)) {
      setNotice(text.skillPathExists);
      return;
    }
    setSettings((current) => ({
      ...current,
      extraSkillPaths: [...current.extraSkillPaths, path],
    }));
    setNewSkillPath("");
    setNotice(text.skillPathAdded);
  }

  function removeExtraSkillPath(path: string) {
    setSettings((current) => ({
      ...current,
      extraSkillPaths: current.extraSkillPaths.filter((item) => item !== path),
    }));
    setNotice(text.skillPathRemoved);
  }

  async function enrichWithGithubMatches(scanned: SkillResource[]) {
    if (!settings.githubMatchingEnabled || settings.githubIndexUrls.length === 0 || scanned.length === 0) {
      return scanned;
    }
    setNotice(text.githubMatching);
    const matches = await invoke<GitHubSourceMatch[]>("match_github_sources", {
      indexUrls: settings.githubIndexUrls,
      resources: scanned,
    });
    return applyGithubMatches(scanned, matches);
  }

  function addGithubIndexUrl() {
    const url = newIndexUrl.trim();
    if (!url) {
      setNotice(text.githubIndexRequired);
      return;
    }
    if (!url.startsWith("https://")) {
      setNotice(text.githubIndexHttpsRequired);
      return;
    }
    if (settings.githubIndexUrls.includes(url)) {
      setNotice(text.githubIndexExists);
      return;
    }
    setSettings((current) => ({
      ...current,
      githubIndexUrls: [...current.githubIndexUrls, url],
    }));
    setNewIndexUrl("");
    setNotice(text.githubIndexAdded);
  }

  function removeGithubIndexUrl(url: string) {
    setSettings((current) => ({
      ...current,
      githubIndexUrls: current.githubIndexUrls.filter((item) => item !== url),
    }));
    setNotice(text.githubIndexRemoved);
  }

  const text = labels[settings.language];

  return (
    <main className="shell">
      <aside className="sidebar" aria-label="Primary">
        <div className="brand">
          <span className="brand-mark">SH</span>
          <div className="brand-text">
            <strong>Skill Hub</strong>
            <span>Skills and plugins</span>
          </div>
        </div>
        <nav className="nav-list" aria-label="Inventory views">
          {(["overview", "skills", "plugins", "sources"] as NavItem[]).map((item) => (
            <NavButton
              active={activeNav === item}
              item={item}
              key={item}
              label={text.nav[item]}
              onClick={() => {
                setActiveNav(item);
                setPendingDelete(false);
              }}
            />
          ))}
        </nav>
        <div className="sidebar-bottom">
          <NavButton
            active={activeNav === "settings"}
            item="settings"
            label={text.nav.settings}
            onClick={() => {
              setActiveNav("settings");
              setPendingDelete(false);
            }}
          />
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">{text.eyebrow}</p>
            <h1>{activeNav === "sources" ? text.nav.sources : activeNav === "settings" ? text.nav.settings : text.inventory}</h1>
          </div>
          <button className="primary" onClick={refreshInventory} type="button">
            {text.refresh}
          </button>
        </header>

        {notice && <div className="notice">{notice}</div>}

        {activeNav === "sources" ? (
          <section className="source-panel">
            <div className="field-grid">
              <label>
                GitHub URL
                <input value={sourceUrl} onChange={(event) => setSourceUrl(event.currentTarget.value)} />
              </label>
              <label>
                Resource name
                <input value={sourceName} onChange={(event) => setSourceName(event.currentTarget.value)} />
              </label>
              <label>
                Host
                <select value={sourceHost} onChange={(event) => setSourceHost(event.currentTarget.value as HostKind)}>
                  <option value="codex">Codex</option>
                  <option value="claude">Claude</option>
                </select>
              </label>
              <label>
                Kind
                <select value={sourceKind} onChange={(event) => setSourceKind(event.currentTarget.value as ResourceKind)}>
                  <option value="skill">Skill</option>
                  <option value="plugin">Plugin</option>
                </select>
              </label>
            </div>
            <button className="primary" onClick={previewSource} type="button">
              Preview
            </button>
            {preview && (
              <div className="preview">
                <h2>{preview.name}</h2>
                <p>{preview.targetPath}</p>
                <button className="primary" onClick={installPreview} type="button">
                  Install
                </button>
              </div>
            )}
          </section>
        ) : activeNav === "settings" ? (
          <section className="settings-panel" aria-label="Settings">
            <div className="settings-grid">
              <section className="setting-card">
                <div>
                  <h2>{text.language}</h2>
                  <p>{text.languageHint}</p>
                </div>
                <select
                  aria-label={text.language}
                  value={settings.language}
                  onChange={(event) => {
                    const language = event.currentTarget.value as Language;
                    setSettings((current) => ({ ...current, language }));
                  }}
                >
                  <option value="en">English</option>
                  <option value="zh">中文</option>
                </select>
              </section>

              <section className="setting-card">
                <div>
                  <h2>{text.theme}</h2>
                  <p>{text.themeHint}</p>
                </div>
                <div className="segmented" role="group" aria-label={text.theme}>
                  {(["dark", "light"] as Theme[]).map((theme) => (
                    <button
                      className={settings.theme === theme ? "active" : ""}
                      key={theme}
                      onClick={() => setSettings((current) => ({ ...current, theme }))}
                      type="button"
                    >
                      {theme === "dark" ? text.dark : text.light}
                    </button>
                  ))}
                </div>
              </section>
            </div>

            <section className="setting-card path-card">
              <div>
                <h2>{text.extraPaths}</h2>
                <p>{text.extraPathsHint}</p>
              </div>
              <div className="path-entry">
                <input
                  aria-label={text.skillPath}
                  placeholder="~/path/to/skills"
                  value={newSkillPath}
                  onChange={(event) => setNewSkillPath(event.currentTarget.value)}
                />
                <button className="primary" onClick={addExtraSkillPath} type="button">
                  {text.addPath}
                </button>
              </div>
              <div className="path-list">
                {settings.extraSkillPaths.length === 0 ? (
                  <p>{text.noExtraPaths}</p>
                ) : (
                  settings.extraSkillPaths.map((path) => (
                    <div className="path-row" key={path}>
                      <span>{path}</span>
                      <button onClick={() => removeExtraSkillPath(path)} type="button">
                        {text.remove}
                      </button>
                    </div>
                  ))
                )}
              </div>
            </section>

            <section className="setting-card path-card">
              <div className="setting-headline">
                <div>
                  <h2>{text.githubMatchingTitle}</h2>
                  <p>{text.githubMatchingHint}</p>
                </div>
                <label className="toggle-row">
                  <input
                    checked={settings.githubMatchingEnabled}
                    type="checkbox"
                    onChange={(event) =>
                      setSettings((current) => ({
                        ...current,
                        githubMatchingEnabled: event.currentTarget.checked,
                      }))
                    }
                  />
                  <span>{text.githubMatchingConsent}</span>
                </label>
              </div>
              <div className="path-entry">
                <input
                  aria-label={text.githubIndexUrl}
                  placeholder="https://raw.githubusercontent.com/org/repo/main/skills-index.json"
                  value={newIndexUrl}
                  onChange={(event) => setNewIndexUrl(event.currentTarget.value)}
                />
                <button className="primary" onClick={addGithubIndexUrl} type="button">
                  {text.addIndex}
                </button>
              </div>
              <div className="path-list">
                {settings.githubIndexUrls.length === 0 ? (
                  <p>{text.noGithubIndexes}</p>
                ) : (
                  settings.githubIndexUrls.map((url) => (
                    <div className="path-row" key={url}>
                      <span>{url}</span>
                      <button onClick={() => removeGithubIndexUrl(url)} type="button">
                        {text.remove}
                      </button>
                    </div>
                  ))
                )}
              </div>
            </section>
          </section>
        ) : (
          <>
            <section className="cards" aria-label="Inventory health">
              <Metric label={text.metrics.skills} value={skillCount} />
              <Metric label={text.metrics.plugins} value={pluginCount} />
              <Metric label={text.metrics.githubTracked} value={githubCount} />
              <Metric label={text.metrics.linked} value={linkedCount} />
              <Metric label={text.metrics.warnings} value={warningCount} />
            </section>

            <section className="filters" aria-label={text.inventoryFilters}>
              <input
                aria-label={text.searchResources}
                placeholder={text.searchResources}
                value={filters.query}
                onChange={(event) => setFilters({ ...filters, query: event.currentTarget.value })}
              />
              <select
                aria-label={text.kind}
                value={filters.kind}
                onChange={(event) => setFilters({ ...filters, kind: event.currentTarget.value as InventoryFilters["kind"] })}
              >
                <option value="all">{text.allKinds}</option>
                <option value="skill">{text.metrics.skills}</option>
                <option value="plugin">{text.metrics.plugins}</option>
                <option value="unknown">{text.unknown}</option>
              </select>
              <select
                aria-label={text.host}
                value={filters.host}
                onChange={(event) => setFilters({ ...filters, host: event.currentTarget.value as InventoryFilters["host"] })}
              >
                <option value="all">{text.allHosts}</option>
                <option value="codex">Codex</option>
                <option value="claude">Claude</option>
              </select>
            </section>

            <section className="source-tabs" aria-label={text.sourceFilter}>
              {(["all", "native", "github", "local", "registry", "linked"] as Array<"all" | SourceKind>).map((source) => {
                const label = source === "all" ? text.allSources : text.sourceKinds[source];
                const count = sourceCount(scopedResources, source);
                return (
                  <button
                    aria-label={`${label} ${count}`}
                    className={filters.source === source ? "source-tab active" : "source-tab"}
                    key={source}
                    onClick={() => setFilters({ ...filters, source })}
                    type="button"
                  >
                    <span>{label}</span>
                    <strong>{count}</strong>
                  </button>
                );
              })}
            </section>

            <section className="content-grid">
              <div className="resource-table">
                <div className="table-header">
                  <span>{text.resource}</span>
                  <span>{text.type}</span>
                  <span>{text.status}</span>
                </div>
                {visibleResources.length === 0 && (
                  <div className="empty-state">
                    <strong>{text.noMatches}</strong>
                    <span>{text.noMatchesHint}</span>
                  </div>
                )}
                {visibleResources.map((resource) => (
                  <button
                    className={selected?.id === resource.id ? "resource-row selected" : "resource-row"}
                    key={resource.id}
                    onClick={() => {
                      setSelectedId(resource.id);
                      setPendingDelete(false);
                      setSummaryExpanded(false);
                    }}
                    type="button"
                  >
                    <span className="resource-main">
                      <span className="resource-title-line">
                        <strong>{resource.name}</strong>
                        <SourceBadge sourceKind={resource.sourceKind} text={text} />
                      </span>
                      <small>{compactPath(resource.path)}</small>
                    </span>
                    <span className="resource-meta">
                      <HostChip host={resource.host} />
                      <em>{resourceKindLabel(resource.kind, text)}</em>
                    </span>
                    <span className={`update-pill ${resource.sourceKind}`}>
                      {updateStatusLabel(resource.updateStatus, text)}
                    </span>
                  </button>
                ))}
              </div>

              <aside className="drawer" aria-label="Resource details">
                {selected ? (
                  <>
                    <div className="drawer-heading">
                      <div>
                        <h2>{selected.name}</h2>
                        <p>{sourceLabel(selected.sourceKind, text)} {resourceKindLabel(selected.kind, text)}</p>
                      </div>
                      <SourceBadge sourceKind={selected.sourceKind} text={text} />
                    </div>

                    <section className="summary-block">
                      <div className="summary-head">
                        <strong>{text.summary}</strong>
                        <button
                          className="link-button"
                          onClick={() => setSummaryExpanded((current) => !current)}
                          type="button"
                        >
                          {summaryExpanded ? text.collapse : text.expand}
                        </button>
                      </div>
                      <p className={summaryExpanded ? "summary-text expanded" : "summary-text"}>
                        {selected.summary}
                      </p>
                    </section>

                    <dl>
                      <dt>{text.source}</dt>
                      <dd>
                        {selected.sourceUrl ? (
                          <a href={selected.sourceUrl} target="_blank" rel="noreferrer">
                            {selected.sourceUrl}
                          </a>
                        ) : (
                          sourceLabel(selected.sourceKind, text)
                        )}
                      </dd>
                      <dt>{text.updateStatus}</dt>
                      <dd>{updateStatusLabel(selected.updateStatus, text)}</dd>
                      <dt>{text.path}</dt>
                      <dd>{selected.path}</dd>
                      <dt>{text.compatibility}</dt>
                      <dd>{selected.compatibility.map(titleCase).join(", ")}</dd>
                      <dt>{text.status}</dt>
                      <dd>{statusLabel(selected.status, text)}</dd>
                    </dl>
                    {selected.warnings.length > 0 && (
                      <ul className="warnings">
                        {selected.warnings.map((warning) => (
                          <li key={warning}>{warning}</li>
                        ))}
                      </ul>
                    )}
                    <button className="danger" onClick={deleteSelected} type="button">
                      {pendingDelete ? text.confirmDelete : text.delete}
                    </button>
                  </>
                ) : (
                  <p>{text.noSelection}</p>
                )}
              </aside>
            </section>
          </>
        )}
      </section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function sourceCount(resources: SkillResource[], source: "all" | SourceKind) {
  return source === "all" ? resources.length : resources.filter((resource) => resource.sourceKind === source).length;
}

function applyGithubMatches(resources: SkillResource[], matches: GitHubSourceMatch[]) {
  const byResourceId = new Map(matches.map((match) => [match.resourceId, match]));
  return resources.map((resource) => {
    const match = byResourceId.get(resource.id);
    if (!match || !["verified", "probable"].includes(match.confidence)) {
      return resource;
    }
    return {
      ...resource,
      sourceKind: "github" as const,
      sourceUrl: match.sourceUrl,
      updateStatus: match.confidence === "verified" ? "GitHub verified" : "GitHub probable",
    };
  });
}

function NavButton({
  active,
  item,
  label,
  onClick,
}: {
  active: boolean;
  item: NavItem;
  label: string;
  onClick: () => void;
}) {
  return (
    <button className={active ? "nav-item active" : "nav-item"} onClick={onClick} type="button" title={label}>
      <span aria-hidden="true" className="nav-icon">
        {navIcon(item)}
      </span>
      <span className="nav-label">{label}</span>
    </button>
  );
}

function HostChip({ host }: { host: HostKind }) {
  return <span className={`chip ${host}`}>{titleCase(host)}</span>;
}

function navIcon(item: NavItem) {
  const icons: Record<NavItem, string> = {
    overview: "O",
    skills: "S",
    plugins: "P",
    sources: "G",
    settings: "⚙",
  };
  return icons[item];
}

type Labels = (typeof labels)[Language];

function SourceBadge({ sourceKind, text }: { sourceKind: SkillResource["sourceKind"]; text: Labels }) {
  return <span className={`source-badge ${sourceKind}`}>{sourceLabel(sourceKind, text)}</span>;
}

function sourceLabel(sourceKind: SkillResource["sourceKind"], text: Labels) {
  return text.sourceKinds[sourceKind];
}

function resourceKindLabel(kind: ResourceKind, text: Labels) {
  return text.resourceKinds[kind];
}

function updateStatusLabel(status: string, text: Labels) {
  return text.updateStatuses[status.toLowerCase()] ?? status;
}

function statusLabel(status: string, text: Labels) {
  return text.statuses[status.toLowerCase()] ?? titleCase(status);
}

function titleCase(value: string) {
  return value.charAt(0).toLocaleUpperCase() + value.slice(1);
}

function compactPath(path: string) {
  const home = "/Users/jerry";
  const compact = path.startsWith(home) ? path.replace(home, "~") : path;
  if (compact.length <= 64) {
    return compact;
  }
  return `...${compact.slice(-61)}`;
}

function rootFromResourcePath(path: string) {
  const marker = path.includes("/skills/") ? "/skills/" : "/plugins/";
  return path.includes(marker) ? path.slice(0, path.indexOf(marker)) : path;
}

function loadSettings(): AppSettings {
  const defaults: AppSettings = {
    language: "en",
    theme: "dark",
    extraSkillPaths: [],
    githubMatchingEnabled: false,
    githubIndexUrls: [],
  };
  try {
    const storage = window.localStorage;
    const raw = storage?.getItem("skillHubSettings");
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      language: parsed.language === "zh" ? "zh" : "en",
      theme: parsed.theme === "light" ? "light" : "dark",
      extraSkillPaths: Array.isArray(parsed.extraSkillPaths)
        ? parsed.extraSkillPaths.filter((path): path is string => typeof path === "string" && path.trim().length > 0)
        : [],
      githubMatchingEnabled: parsed.githubMatchingEnabled === true,
      githubIndexUrls: Array.isArray(parsed.githubIndexUrls)
        ? parsed.githubIndexUrls.filter((url): url is string => typeof url === "string" && url.trim().length > 0)
        : [],
    };
  } catch {
    return defaults;
  }
}

function saveSettings(settings: AppSettings) {
  try {
    window.localStorage?.setItem("skillHubSettings", JSON.stringify(settings));
  } catch {
    // Settings are non-critical; keep the app usable if storage is unavailable.
  }
}

function translateKnownNotice(notice: string, language: Language) {
  const known = new Map<string, keyof Labels>([
    ["Fixture inventory loaded.", "fixtureLoaded"],
    ["Scanning local skill roots...", "scanning"],
    ["Inventory refreshed.", "inventoryRefreshed"],
    ["No configured host roots were found.", "noRoots"],
    ["Skill path is required.", "skillPathRequired"],
    ["Skill path already exists.", "skillPathExists"],
    ["Skill path added. Inventory will refresh.", "skillPathAdded"],
    ["Skill path removed. Inventory will refresh.", "skillPathRemoved"],
    ["Install preview is ready.", "previewReady"],
    ["Source URL and resource name are required.", "sourceRequired"],
  ]);
  const key = known.get(notice);
  return key ? String(labels[language][key]) : notice;
}

const labels: Record<Language, {
  allHosts: string;
  allKinds: string;
  allSources: string;
  addPath: string;
  addIndex: string;
  collapse: string;
  compatibility: string;
  confirmDelete: string;
  dark: string;
  delete: string;
  extraPaths: string;
  extraPathsHint: string;
  eyebrow: string;
  fixtureLoaded: string;
  host: string;
  githubIndexAdded: string;
  githubIndexExists: string;
  githubIndexHttpsRequired: string;
  githubIndexRemoved: string;
  githubIndexRequired: string;
  githubIndexUrl: string;
  githubMatching: string;
  githubMatchingConsent: string;
  githubMatchingHint: string;
  githubMatchingTitle: string;
  inventory: string;
  inventoryFilters: string;
  inventoryRefreshed: string;
  installed: string;
  kind: string;
  language: string;
  languageHint: string;
  light: string;
  metrics: {
    githubTracked: string;
    linked: string;
    plugins: string;
    skills: string;
    warnings: string;
  };
  movedToTrash: string;
  nav: Record<NavItem, string>;
  noExtraPaths: string;
  noGithubIndexes: string;
  noMatches: string;
  noMatchesHint: string;
  noRoots: string;
  noSelection: string;
  path: string;
  previewReady: string;
  refresh: string;
  remove: string;
  resource: string;
  resourceKinds: Record<ResourceKind, string>;
  scanning: string;
  searchResources: string;
  skillPathAdded: string;
  skillPathExists: string;
  skillPathRemoved: string;
  skillPathRequired: string;
  skillPath: string;
  source: string;
  sourceFilter: string;
  sourceKinds: Record<SkillResource["sourceKind"], string>;
  sourceRequired: string;
  status: string;
  statuses: Record<string, string>;
  summary: string;
  theme: string;
  themeHint: string;
  type: string;
  unknown: string;
  updateStatus: string;
  updateStatuses: Record<string, string>;
  expand: string;
}> = {
  en: {
    allHosts: "All hosts",
    allKinds: "All kinds",
    allSources: "All",
    addPath: "Add path",
    addIndex: "Add index",
    collapse: "Collapse",
    compatibility: "Compatibility",
    confirmDelete: "Confirm delete",
    dark: "Dark",
    delete: "Delete",
    expand: "Expand",
    extraPaths: "Extra skill paths",
    extraPathsHint: "Add a skill folder or a folder that contains multiple skills. Refresh will include these paths.",
    eyebrow: "Local inventory",
    fixtureLoaded: "Fixture inventory loaded.",
    githubIndexAdded: "GitHub index added.",
    githubIndexExists: "GitHub index already exists.",
    githubIndexHttpsRequired: "GitHub index URL must start with https://.",
    githubIndexRemoved: "GitHub index removed.",
    githubIndexRequired: "GitHub index URL is required.",
    githubIndexUrl: "GitHub index URL",
    githubMatching: "Matching local skills against GitHub indexes...",
    githubMatchingConsent: "Enable online matching",
    githubMatchingHint: "Downloads public index JSON files only. Local skill files and paths are not uploaded.",
    githubMatchingTitle: "GitHub source matching",
    host: "Host",
    inventory: "Inventory",
    inventoryFilters: "Inventory filters",
    inventoryRefreshed: "Inventory refreshed.",
    installed: "installed.",
    kind: "Kind",
    language: "Language",
    languageHint: "Controls navigation and settings labels.",
    light: "Light",
    metrics: {
      githubTracked: "GitHub tracked",
      linked: "Linked",
      plugins: "Plugins",
      skills: "Skills",
      warnings: "Warnings",
    },
    movedToTrash: "moved to trash.",
    nav: {
      overview: "Overview",
      skills: "Skills",
      plugins: "Plugins",
      sources: "Sources",
      settings: "Settings",
    },
    noExtraPaths: "No extra skill paths configured.",
    noGithubIndexes: "No GitHub indexes configured.",
    noMatches: "No resources match the current filters.",
    noMatchesHint: "Refresh inventory or clear search terms.",
    noRoots: "No configured host roots were found.",
    noSelection: "No resource selected.",
    path: "Path",
    previewReady: "Install preview is ready.",
    refresh: "Refresh",
    remove: "Remove",
    resource: "Resource",
    resourceKinds: {
      plugin: "Plugin",
      skill: "Skill",
      unknown: "Unknown",
    },
    scanning: "Scanning local skill roots...",
    searchResources: "Search resources",
    skillPath: "Skill path",
    skillPathAdded: "Skill path added. Inventory will refresh.",
    skillPathExists: "Skill path already exists.",
    skillPathRemoved: "Skill path removed. Inventory will refresh.",
    skillPathRequired: "Skill path is required.",
    source: "Source",
    sourceFilter: "Source tags",
    sourceKinds: {
      github: "GitHub",
      linked: "Linked",
      local: "Local",
      native: "Native",
      registry: "Registry",
    },
    sourceRequired: "Source URL and resource name are required.",
    status: "Status",
    statuses: {
      incompatible: "Incompatible",
      ready: "Ready",
      warning: "Warning",
    },
    summary: "Summary",
    theme: "Theme",
    themeHint: "Switch the app surface without changing scanned resources.",
    type: "Type",
    unknown: "Unknown",
    updateStatus: "Update status",
    updateStatuses: {
      linked: "Linked",
      managed: "Managed",
      manual: "Manual",
      registry: "Registry",
      trackable: "Trackable",
      "github verified": "GitHub verified",
      "github probable": "GitHub probable",
    },
  },
  zh: {
    allHosts: "全部主机",
    allKinds: "全部类型",
    allSources: "全部",
    addPath: "添加路径",
    addIndex: "添加索引",
    collapse: "收起",
    compatibility: "兼容性",
    confirmDelete: "确认删除",
    dark: "深色",
    delete: "删除",
    expand: "展开",
    extraPaths: "额外 Skill 路径",
    extraPathsHint: "可以添加单个 Skill 文件夹，也可以添加包含多个 Skill 的目录。刷新时会一起扫描。",
    eyebrow: "本地资源",
    fixtureLoaded: "已加载测试资源。",
    githubIndexAdded: "GitHub 索引已添加。",
    githubIndexExists: "GitHub 索引已存在。",
    githubIndexHttpsRequired: "GitHub 索引 URL 必须以 https:// 开头。",
    githubIndexRemoved: "GitHub 索引已移除。",
    githubIndexRequired: "请输入 GitHub 索引 URL。",
    githubIndexUrl: "GitHub 索引 URL",
    githubMatching: "正在对照 GitHub 索引匹配本地 Skill...",
    githubMatchingConsent: "启用联网匹配",
    githubMatchingHint: "只下载公开索引 JSON；不会上传本地 Skill 文件或路径。",
    githubMatchingTitle: "GitHub 来源匹配",
    host: "主机",
    inventory: "资源库",
    inventoryFilters: "资源筛选",
    inventoryRefreshed: "资源库已刷新。",
    installed: "已安装。",
    kind: "类型",
    language: "语言",
    languageHint: "控制导航和设置里的界面文案。",
    light: "浅色",
    metrics: {
      githubTracked: "GitHub 跟踪",
      linked: "软链",
      plugins: "插件",
      skills: "Skills",
      warnings: "警告",
    },
    movedToTrash: "已移到废纸篓。",
    nav: {
      overview: "总览",
      skills: "Skills",
      plugins: "Plugins",
      sources: "来源",
      settings: "设置",
    },
    noExtraPaths: "还没有配置额外路径。",
    noGithubIndexes: "还没有配置 GitHub 索引。",
    noMatches: "没有符合当前筛选条件的资源。",
    noMatchesHint: "刷新资源库，或清空搜索条件。",
    noRoots: "没有找到已配置的主机根目录。",
    noSelection: "未选择资源。",
    path: "路径",
    previewReady: "安装预览已生成。",
    refresh: "刷新",
    remove: "移除",
    resource: "资源",
    resourceKinds: {
      plugin: "插件",
      skill: "Skill",
      unknown: "未知",
    },
    scanning: "正在扫描本地 Skill 根目录...",
    searchResources: "搜索资源",
    skillPath: "Skill 路径",
    skillPathAdded: "Skill 路径已添加，资源库会自动刷新。",
    skillPathExists: "Skill 路径已存在。",
    skillPathRemoved: "Skill 路径已移除，资源库会自动刷新。",
    skillPathRequired: "请输入 Skill 路径。",
    source: "来源",
    sourceFilter: "来源标签",
    sourceKinds: {
      github: "GitHub",
      linked: "软链",
      local: "本地",
      native: "原生",
      registry: "注册表",
    },
    sourceRequired: "需要填写来源 URL 和资源名称。",
    status: "状态",
    statuses: {
      incompatible: "不兼容",
      ready: "就绪",
      warning: "警告",
    },
    summary: "摘要",
    theme: "主题",
    themeHint: "切换界面外观，不影响已经扫描到的资源。",
    type: "类型",
    unknown: "未知",
    updateStatus: "更新状态",
    updateStatuses: {
      linked: "软链",
      managed: "托管",
      manual: "手动",
      registry: "注册表",
      trackable: "可跟踪",
      "github verified": "GitHub 已验证",
      "github probable": "GitHub 可能匹配",
    },
  },
};

export default App;
