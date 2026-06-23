import { type CSSProperties, type ReactElement, memo, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Blocks, BookOpenCheck, Grid2X2, LayoutDashboard, List, Plus, Settings, ShoppingBag, SlidersHorizontal } from "lucide-react";
import { LimelightNav, type LimelightNavItem } from "@/components/ui/limelight-nav";
import { filterInventory } from "./inventory";
import type {
  GitHubSourceMatch,
  HostKind,
  InventoryFilters,
  MarketEntry,
  MarketResult,
  SkillResource,
  SourceKind,
  UpdateCheck,
} from "./types";
import "./App.css";

type NavView = "overview" | "skills" | "plugins" | "market" | "settings";
type Language = "en" | "zh";
type Theme = "dark" | "light";
type ResourceViewMode = "list" | "grid";
type MarketKindFilter = "skill" | "plugin";
type AppUpdateStatus = "idle" | "checking" | "available" | "downloading" | "installing" | "error";
type SourceStatus = "loading" | "success" | "error";

interface SourceState {
  label: string;
  status: SourceStatus;
  count?: number;
  error?: string;
}

interface AppUpdateState {
  status: AppUpdateStatus;
  version: string | null;
  progress: number;
  error: string | null;
}

type AppUpdateDownloadEvent =
  | { event: "Started"; data?: { contentLength?: number } }
  | { event: "Progress"; data?: { chunkLength?: number } }
  | { event: "Finished"; data?: unknown };

interface AppSettings {
  language: Language;
  theme: Theme;
  extraSkillPaths: string[];
  githubMatchingEnabled: boolean;
  githubIndexUrls: string[];
  marketSources: string[];
  githubToken: string;
  remoteIndexUrl: string;
  customRegistrySources: string[];
}

const DEFAULT_MARKET_SOURCES = [
  "https://github.com/anthropics/skills",
  "https://github.com/obra/superpowers",
  "https://github.com/anthropics/claude-plugins-official",
];
const LEGACY_DEFAULT_MARKET_SOURCES = DEFAULT_MARKET_SOURCES.slice(0, 2);
const DEFAULT_REMOTE_INDEX_URL =
  "https://raw.githubusercontent.com/JerryLiu-uestc/skill-hub/gh-pages/index.json";

const MARKET_CACHE_KEY = "skillHubMarketCache";
const MARKET_CACHE_TTL_MS = 30 * 60 * 1000;
const MARKET_PAGE_SIZE = 60;
const MARKET_SOURCE_TIMEOUT_MS = 120000;

interface MarketCache {
  cachedAt: number;
  entries: MarketEntry[];
  sourceSignature: string;
}

interface AppProps {
  initialResources?: SkillResource[];
  initialMarket?: MarketEntry[];
  onDeleteResource?: (path: string) => void | Promise<void>;
  onInstallMarket?: (entry: MarketEntry, host: HostKind) => void | Promise<void>;
  onCheckUpdate?: (resource: SkillResource) => UpdateCheck | Promise<UpdateCheck>;
  onUpdateResource?: (resource: SkillResource) => void | Promise<void>;
  onDiscoverRepo?: (url: string) => MarketEntry[] | Promise<MarketEntry[]>;
  onDiscoverMarketSource?: (source: string) => MarketResult | Promise<MarketResult>;
  onDiscoverCuratedCatalog?: () => MarketResult | Promise<MarketResult>;
  onDiscoverBuiltinIndex?: () => MarketResult | Promise<MarketResult>;
}

function App({
  initialResources,
  initialMarket,
  onDeleteResource,
  onInstallMarket,
  onCheckUpdate,
  onUpdateResource,
  onDiscoverRepo,
  onDiscoverMarketSource,
  onDiscoverBuiltinIndex,
}: AppProps) {
  const [activeNav, setActiveNav] = useState<NavView>("overview");
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
  const cachedMarket = initialMarket ? null : readMarketCache(settings);
  const [market, setMarket] = useState<MarketEntry[]>(initialMarket ?? cachedMarket?.entries ?? []);
  const [marketCachedAt, setMarketCachedAt] = useState<number | null>(cachedMarket?.cachedAt ?? null);
  const [marketQuery, setMarketQuery] = useState("");
  const [marketHost, setMarketHost] = useState<HostKind>("codex");
  const [marketLoading, setMarketLoading] = useState(false);
  const [sourceStates, setSourceStates] = useState<Record<string, SourceState>>({});
  const [marketVisibleCount, setMarketVisibleCount] = useState(MARKET_PAGE_SIZE);
  const [resourceViewMode, setResourceViewMode] = useState<ResourceViewMode>("list");
  const [installingUrl, setInstallingUrl] = useState<string | null>(null);
  const [marketSort, setMarketSort] = useState<"stars" | "name">("stars");
  const [marketKind, setMarketKind] = useState<MarketKindFilter>("plugin");
  const [newMarketSource, setNewMarketSource] = useState("");
  const [showMarketSourceEntry, setShowMarketSourceEntry] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheck | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [pendingUpdate, setPendingUpdate] = useState(false);
  const [appUpdate, setAppUpdate] = useState<AppUpdateState>({
    status: "idle",
    version: null,
    progress: 0,
    error: null,
  });
  const [notice, setNotice] = useState(initialResources ? "Fixture inventory loaded." : "Scanning local skill roots...");
  const [showUpdateDialog, setShowUpdateDialog] = useState(false);
  const updateDialogShownRef = useRef(false);
  const marketPrefetchKeyRef = useRef<string | null>(cachedMarket ? marketSourceSignature(settings) : null);
  const settingsPanelRef = useRef<HTMLElement | null>(null);
  const appUpdateRef = useRef<unknown | null>(null);
  const text = labels[settings.language];

  useEffect(() => {
    if (!initialResources) {
      refreshInventory();
    }
  }, [initialResources, settings.extraSkillPaths]);

  useEffect(() => {
    if (initialResources || !isTauriRuntime()) return;
    const timer = window.setTimeout(() => {
      void checkForAppUpdate({ background: true });
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [initialResources]);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
    saveSettings(settings);
    setNotice((current) => translateKnownNotice(current, settings.language));
  }, [settings]);

  useEffect(() => {
    setMarketVisibleCount(MARKET_PAGE_SIZE);
  }, [marketKind, marketQuery, marketSort, market]);

  useEffect(() => {
    if (activeNav === "settings") {
      const panel = settingsPanelRef.current;
      if (panel) {
        panel.scrollTop = 0;
        panel.scrollTo?.({ top: 0 });
      }
    }
  }, [activeNav]);

  useEffect(() => {
    if (initialMarket || initialResources || marketLoading) return;

    const sourceSignature = marketSourceSignature(settings);
    if (marketPrefetchKeyRef.current === sourceSignature) return;

    const cached = readMarketCache(settings);
    if (cached) {
      marketPrefetchKeyRef.current = sourceSignature;
      setMarket(cached.entries);
      setMarketCachedAt(cached.cachedAt);
      return;
    }

    marketPrefetchKeyRef.current = sourceSignature;
    const timer = window.setTimeout(() => {
      void refreshMarket({ background: true });
    }, 1200);

    return () => window.clearTimeout(timer);
  }, [initialMarket, initialResources, marketLoading, resources.length, settings.githubToken, settings.marketSources]);

  const scopedResources = useMemo(
    () => filterInventory(resources, { ...filters, source: "all" }).filter((resource) => {
      if (activeNav === "skills") return resource.kind === "skill";
      if (activeNav === "plugins") return resource.kind === "plugin";
      return activeNav !== "settings";
    }),
    [activeNav, filters, resources],
  );

  const visibleResources = useMemo(() => {
    const selectedSource = filters.source;
    if (selectedSource === "all") {
      return scopedResources;
    }
    return scopedResources.filter((resource) => matchesSourceGroup(resource.sourceKind, selectedSource));
  }, [filters.source, scopedResources]);

  const selected = visibleResources.find((resource) => resource.id === selectedId) ?? visibleResources[0];

  const visibleMarket = useMemo(() => {
    const query = marketQuery.trim().toLocaleLowerCase();
    const kindFiltered = market.filter((entry) => entry.kind === marketKind);
    const filtered = !query
      ? kindFiltered
      : kindFiltered.filter((entry) =>
          [entry.name, entry.summary ?? "", entry.sourceUrl, entry.repo ?? ""]
            .join(" ")
            .toLocaleLowerCase()
            .includes(query),
        );
    const sorted = [...filtered].sort((a, b) => {
      if (marketSort === "name") return a.name.localeCompare(b.name);
      return (b.stars ?? 0) - (a.stars ?? 0) || a.name.localeCompare(b.name);
    });
    return sorted;
  }, [market, marketKind, marketQuery, marketSort]);

  const displayedMarket = useMemo(
    () => visibleMarket.slice(0, marketVisibleCount),
    [marketVisibleCount, visibleMarket],
  );
  const installedMarketResources = useMemo(
    () => resources.filter((resource) => resource.kind === marketKind),
    [marketKind, resources],
  );
  const installedMarketNav = marketKind === "plugin" ? "plugins" : "skills";
  const featuredMarket = useMemo(
    () => displayedMarket.filter((entry) => !entry.installed && isFeaturedMarketEntry(entry)),
    [displayedMarket],
  );
  const communityMarket = useMemo(
    () => displayedMarket.filter((entry) => !entry.installed && !isFeaturedMarketEntry(entry)),
    [displayedMarket],
  );
  const currentMarketTitle = text.marketKinds[marketKind];
  const currentMarketSubtitle = text.marketKindSubtitles[marketKind];

  const skillCount = resources.filter((resource) => resource.kind === "skill").length;
  const pluginCount = resources.filter((resource) => resource.kind === "plugin").length;
  const githubCount = resources.filter((resource) => resource.sourceKind === "github").length;

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

  function removeMarketSource(url: string) {
    setSettings((current) => ({
      ...current,
      marketSources: current.marketSources.filter((item) => item !== url),
    }));
    setNotice(text.marketSourceRemoved);
  }

  function addMarketSource() {
    const url = newMarketSource.trim();
    if (!url) {
      setNotice(text.marketSourceRequired);
      return;
    }
    if (!url.toLowerCase().startsWith("https://github.com/") && !url.toLowerCase().startsWith("git@github.com:")) {
      setNotice(text.marketSourceInvalid);
      return;
    }
    if (settings.marketSources.includes(url)) {
      setNotice(text.marketSourceExists);
      return;
    }
    setSettings((current) => ({
      ...current,
      marketSources: [...current.marketSources, url],
    }));
    setNewMarketSource("");
    setShowMarketSourceEntry(false);
    setMarketCachedAt(null);
    setNotice(text.marketSourceAdded);
  }

  async function refreshMarket({ force = false, background = false }: { force?: boolean; background?: boolean } = {}) {
    if (initialMarket) return;
    if (!force) {
      const cached = readMarketCache(settings);
      if (cached) {
        setMarket(cached.entries);
        setMarketCachedAt(cached.cachedAt);
        if (!background) {
          setNotice(`${text.marketLoadedFromCache} ${formatCachedAt(cached.cachedAt)}`);
        }
        return;
      }
    }
    setMarketLoading(true);
    setSourceStates({});
    if (!background) {
      setNotice(text.marketLoading);
    }

    const token = settings.githubToken || null;
    const sources = settings.marketSources.filter((s) => s.trim().length > 0);
    const currentResources = resources;
    const remoteIndexUrl = settings.remoteIndexUrl || DEFAULT_REMOTE_INDEX_URL;

    // Build initial state: built-in index + remote index + each configured source
    const initial: Record<string, SourceState> = {};
    initial["__builtin__"] = { label: text.curatedCatalog, status: "loading" };
    initial["__remote__"] = { label: "Remote Index", status: "loading" };
    for (const source of sources) {
      initial[source] = { label: sourceUrlLabel(source), status: "loading" };
    }
    setSourceStates(initial);

    // Start fresh for force refresh — clear market so progressive merge starts clean
    setMarket([]);

    // Let React render the loader + source status before IPC starts.
    await new Promise((resolve) => setTimeout(resolve, 40));

    const nextStates: Record<string, SourceState> = { ...initial };
    const entries: MarketEntry[] = [];
    let failedCount = 0;

    const dedupeEntries = () => {
      const seen = new Set<string>();
      return entries.filter((entry) => {
        if (seen.has(entry.sourceUrl)) return false;
        seen.add(entry.sourceUrl);
        return true;
      });
    };

    const commitProgress = () => {
      setSourceStates({ ...nextStates });
      setMarket(dedupeEntries());
    };

    const sourceLabel = (key: string) =>
      nextStates[key]?.label ??
      (key === "__builtin__"
        ? text.curatedCatalog
        : key === "__remote__"
          ? "Remote Index"
          : sourceUrlLabel(key));

    const loadSource = async (key: string, task: Promise<MarketResult>) => {
      try {
        const result = await withTimeout(
          task,
          MARKET_SOURCE_TIMEOUT_MS,
          text.marketSourceTimedOut,
        );
        nextStates[key] = {
          label: sourceLabel(key),
          status: result.entries.length > 0 || result.warnings.length === 0 ? "success" : "error",
          count: result.entries.length,
          error: result.warnings[0],
        };
        entries.push(...result.entries);
        failedCount += result.warnings.length;
      } catch (error) {
        failedCount++;
        nextStates[key] = {
          label: sourceLabel(key),
          status: "error",
          error: String(error).slice(0, 120),
        };
      }
      commitProgress();
    };

    // Step 1: L1 built-in index — load synchronously for instant first paint.
    await loadSource(
      "__builtin__",
      onDiscoverBuiltinIndex
        ? Promise.resolve(onDiscoverBuiltinIndex())
        : invoke<MarketResult>("discover_builtin_index", { resources: currentResources }),
    );

    // Step 2 + 3: L2 remote index + L3 user sources — fire in parallel.
    const tasks: Promise<void>[] = [
      loadSource(
        "__remote__",
        invoke<MarketResult>("refresh_remote_index", {
          url: remoteIndexUrl,
          resources: currentResources,
        }).catch(() => ({ entries: [], warnings: ["Remote index unavailable"] }) as MarketResult),
      ),
    ];

    for (const source of sources) {
      tasks.push(
        loadSource(
          source,
          onDiscoverMarketSource
            ? Promise.resolve(onDiscoverMarketSource(source))
            : invoke<MarketResult>("discover_market_source", { source, token, resources: currentResources }),
        ),
      );
    }

    await Promise.allSettled(tasks);

    const nextMarket = dedupeEntries();
    setSourceStates({ ...nextStates });
    setMarket(nextMarket);
    if (failedCount === 0) {
      const cachedAt = Date.now();
      setMarketCachedAt(cachedAt);
      writeMarketCache(settings, nextMarket, cachedAt);
    } else {
      setMarketCachedAt(null);
      clearMarketCache();
    }

    setMarketLoading(false);
    if (!background) {
      if (failedCount > 0 && nextMarket.length > 0) {
        setNotice(`${text.marketLoaded} ${text.marketSomeSourcesFailed}: ${failedCount}`);
      } else if (failedCount > 0) {
        setNotice(text.marketAllSourcesFailed);
      } else if (nextMarket.length > 0) {
        setNotice(text.marketLoaded);
      } else {
        setNotice(text.marketEmpty);
      }
    }
  }

  async function discoverFromMarketQuery() {
    const url = marketQuery.trim();
    if (!url) {
      setNotice(text.pasteUrlRequired);
      return;
    }
    if (!url.toLowerCase().startsWith("https://github.com/") && !url.toLowerCase().startsWith("git@github.com:")) {
      setNotice(text.pasteUrlInvalid);
      return;
    }
    setDiscovering(true);
    setNotice(text.discovering);
    try {
      let found: MarketEntry[];
      if (onDiscoverRepo) {
        found = await onDiscoverRepo(url);
      } else {
        const result = await invoke<MarketResult>("discover_repo", {
          source: url,
          token: settings.githubToken || null,
          resources,
        });
        if (result.warnings.length > 0 && result.entries.length === 0) {
          setNotice(result.warnings[0]);
          setDiscovering(false);
          return;
        }
        found = result.entries;
      }
      if (found.length === 0) {
        setNotice(text.discoverNone);
        setDiscovering(false);
        return;
      }
      // Merge discovered entries into the market, deduping by source URL.
      setMarket((current) => {
        const seen = new Set(current.map((item) => item.sourceUrl));
        const next = [...current, ...found.filter((item) => !seen.has(item.sourceUrl))];
        setMarketCachedAt(Date.now());
        writeMarketCache(settings, next);
        return next;
      });
      if (found[0]?.kind === "skill" || found[0]?.kind === "plugin") {
        setMarketKind(found[0].kind);
      }
      setMarketQuery("");
      setNotice(`${text.discoverFound}: ${found.length}`);
    } catch (error) {
      setNotice(String(error));
    } finally {
      setDiscovering(false);
    }
  }

  async function installFromMarket(entry: MarketEntry) {
    setInstallingUrl(entry.sourceUrl);
    setNotice(`${entry.name} ${text.marketInstalling}`);
    try {
      if (onInstallMarket) {
        await onInstallMarket(entry, marketHost);
      } else {
        await invoke("install_github_skill", {
          source: entry.sourceUrl,
          host: marketHost,
          root: null,
          kind: entry.kind,
          name: entry.name,
        });
      }
      setMarket((current) => {
        const next = current.map((item) =>
          item.sourceUrl === entry.sourceUrl ? { ...item, installed: true } : item,
        );
        setMarketCachedAt(Date.now());
        writeMarketCache(settings, next);
        return next;
      });
      setNotice(`${entry.name} ${text.installed}`);
      if (!initialResources) {
        refreshInventory();
      }
    } catch (error) {
      setNotice(String(error));
    } finally {
      setInstallingUrl(null);
    }
  }

  async function checkUpdate() {
    if (!selected || selected.sourceKind !== "github" || !selected.sourceUrl) return;
    setUpdateChecking(true);
    setUpdateCheck(null);
    setNotice(text.updateChecking);
    try {
      const result = onCheckUpdate
        ? await onCheckUpdate(selected)
        : await invoke<UpdateCheck>("check_skill_update", {
            source: selected.sourceUrl,
            path: selected.path,
          });
      setUpdateCheck(result);
      setNotice(updateNoticeFor(result.status, text));
    } catch (error) {
      setNotice(String(error));
    } finally {
      setUpdateChecking(false);
    }
  }

  async function applyUpdate() {
    if (!selected || selected.sourceKind !== "github" || !selected.sourceUrl) return;
    if (!pendingUpdate) {
      setPendingUpdate(true);
      return;
    }
    setNotice(`${selected.name} ${text.updating}`);
    try {
      if (onUpdateResource) {
        await onUpdateResource(selected);
      } else {
        await invoke("update_github_skill", {
          source: selected.sourceUrl,
          host: selected.host,
          root: rootFromResourcePath(selected.path),
          kind: selected.kind,
          name: selected.name,
          path: selected.path,
        });
      }
      setNotice(`${selected.name} ${text.updated}`);
      setPendingUpdate(false);
      setUpdateCheck(null);
      if (!initialResources) {
        refreshInventory();
      }
    } catch (error) {
      setNotice(String(error));
      setPendingUpdate(false);
    }
  }

  async function checkForAppUpdate({ background = false }: { background?: boolean } = {}) {
    if (!isTauriRuntime()) return null;
    if (!background) {
      setAppUpdate((current) => ({ ...current, status: "checking", error: null }));
      setNotice(text.appUpdate.checking);
    }
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      appUpdateRef.current = update;
      if (!update) {
        setAppUpdate({ status: "idle", version: null, progress: 0, error: null });
        if (!background) {
          setNotice(text.appUpdate.upToDate);
        }
        return null;
      }
      setAppUpdate({
        status: "available",
        version: update.version,
        progress: 0,
        error: null,
      });
      if (background && !updateDialogShownRef.current) {
        updateDialogShownRef.current = true;
        setShowUpdateDialog(true);
      }
      if (!background) {
        setNotice(`${text.appUpdate.available}: ${update.version}`);
      }
      return update;
    } catch (error) {
      const message = String(error);
      setAppUpdate((current) => ({
        ...current,
        status: background ? "idle" : "error",
        error: message,
      }));
      if (!background) {
        setNotice(message);
      }
      return null;
    }
  }

  async function installAppUpdateNow() {
    if (!isTauriRuntime()) return;
    setAppUpdate((current) => ({
      ...current,
      status: current.status === "available" ? "downloading" : "checking",
      progress: 0,
      error: null,
    }));
    setNotice(text.appUpdate.downloading);
    try {
      // Always re-check to get the latest endpoint data
      appUpdateRef.current = null;
      const update = await checkForAppUpdate({ background: false });
      if (!update) return;

      let downloaded = 0;
      let contentLength = 0;
      await update.download((event: AppUpdateDownloadEvent) => {
        if (event.event === "Started") {
          contentLength = Math.max(0, Number(event.data?.contentLength ?? 0));
          downloaded = 0;
          setAppUpdate((current) => ({ ...current, status: "downloading", progress: 0 }));
          return;
        }
        if (event.event === "Progress") {
          downloaded += Math.max(0, Number(event.data?.chunkLength ?? 0));
          const progress = contentLength > 0 ? Math.min(99, Math.round((downloaded / contentLength) * 100)) : 0;
          setAppUpdate((current) => ({ ...current, status: "downloading", progress }));
          return;
        }
        if (event.event === "Finished") {
          setAppUpdate((current) => ({ ...current, status: "installing", progress: 100 }));
        }
      });

      setNotice(text.appUpdate.installing);
      setAppUpdate((current) => ({ ...current, status: "installing", progress: 100 }));
      await update.install();
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (error) {
      const message = String(error);
      setAppUpdate((current) => ({
        ...current,
        status: "error",
        error: message,
      }));
      setNotice(message);
    }
  }

  const primaryNavItems = navItemsFor(
    ["overview", "skills", "plugins", "market"],
    activeNav,
    text,
    (item) => {
      setActiveNav(item);
      setPendingDelete(false);
    },
  );
  const settingsNavItems = navItemsFor(["settings"], activeNav, text, (item) => {
    setActiveNav(item);
    setPendingDelete(false);
  });
  const primaryActiveIndex =
    activeNav === "settings" ? -1 : primaryNavItems.findIndex((item) => item.id === activeNav);

  return (
    <>
    <main className="shell">
      <aside className="sidebar" aria-label="Primary">
        <div className="brand">
          <span className="brand-mark">SH</span>
          <div className="brand-text">
            <strong>Skill Hub</strong>
            <span>Skills and plugins</span>
          </div>
        </div>
        <LimelightNav
          activeIndex={primaryActiveIndex}
          className="nav-list"
          iconClassName="nav-icon-svg"
          iconContainerClassName="nav-limelight-item"
          items={primaryNavItems}
          limelightClassName="nav-limelight"
          orientation="vertical"
        />
        <div className="sidebar-bottom">
          <LimelightNav
            activeIndex={activeNav === "settings" ? 0 : -1}
            className="nav-list settings-nav"
            iconClassName="nav-icon-svg"
            iconContainerClassName="nav-limelight-item"
            items={settingsNavItems}
            limelightClassName="nav-limelight"
            orientation="vertical"
          />
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">{text.eyebrow}</p>
            <h1>{topbarTitle(activeNav, text)}</h1>
          </div>
          <div className="topbar-actions">
            <AppUpdateControl update={appUpdate} text={text} onCheck={checkForAppUpdate} onInstall={installAppUpdateNow} />
            <button
              className="primary"
              onClick={activeNav === "market" ? () => refreshMarket({ force: true }) : refreshInventory}
              type="button"
            >
              {text.refresh}
            </button>
          </div>
        </header>

        {notice && <div className="notice">{notice}</div>}

        {activeNav === "market" ? (
          <section className="market-panel" aria-label={text.nav.market}>
            <div className="market-kind-tabs" aria-label={text.marketKind} role="tablist">
              {(["plugin", "skill"] as const).map((kind) => (
                <button
                  aria-selected={marketKind === kind}
                  className={marketKind === kind ? "active" : ""}
                  key={kind}
                  onClick={() => setMarketKind(kind)}
                  role="tab"
                  type="button"
                >
                  {text.marketKinds[kind]}
                </button>
              ))}
            </div>

            <div className="market-directory-head">
              <div>
                <h2>{currentMarketTitle}</h2>
                <p>{currentMarketSubtitle}</p>
              </div>
              <div className="market-head-actions">
                <button
                  aria-expanded={showMarketSourceEntry}
                  aria-label={text.addMarketSource}
                  className="ghost icon-button"
                  onClick={() => setShowMarketSourceEntry((current) => !current)}
                  title={text.addMarketSource}
                  type="button"
                >
                  <Plus aria-hidden="true" size={20} />
                </button>
                <button
                  aria-label={text.refresh}
                  className="ghost icon-button"
                  onClick={() => refreshMarket({ force: true })}
                  title={text.refresh}
                  type="button"
                  disabled={marketLoading}
                >
                  ↻
                </button>
              </div>
            </div>

            <div className="market-search-row">
              <input
                aria-label={text.marketSearch}
                className="market-search-input"
                placeholder={text.marketSearch}
                value={marketQuery}
                onChange={(event) => setMarketQuery(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && looksLikeGithubUrl(marketQuery)) {
                    discoverFromMarketQuery();
                  }
                }}
              />
              <button
                className="primary market-discover-button"
                onClick={discoverFromMarketQuery}
                type="button"
                disabled={discovering}
              >
                {discovering ? text.discovering : text.discover}
              </button>
              <button className="ghost icon-button market-filter-button" type="button" title={text.marketFilters} aria-label={text.marketFilters}>
                <SlidersHorizontal aria-hidden="true" size={18} />
              </button>
            </div>

            <div className="market-filter-row">
              <label className="market-host">
                {text.sortBy}
                <select
                  aria-label={text.sortBy}
                  value={marketSort}
                  onChange={(event) => setMarketSort(event.currentTarget.value as "stars" | "name")}
                >
                  <option value="stars">{text.sortStars}</option>
                  <option value="name">{text.sortName}</option>
                </select>
              </label>
              <label className="market-host">
                {text.installTo}
                <select
                  aria-label={text.installTo}
                  value={marketHost}
                  onChange={(event) => setMarketHost(event.currentTarget.value as HostKind)}
                >
                  <option value="codex">Codex</option>
                  <option value="claude">Claude</option>
                </select>
              </label>
            </div>

            {showMarketSourceEntry && (
              <div className="market-source-entry">
                <input
                  aria-label={text.marketSourceUrl}
                  placeholder="https://github.com/owner/repo"
                  value={newMarketSource}
                  onChange={(event) => setNewMarketSource(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") addMarketSource();
                  }}
                />
                <button className="primary" onClick={addMarketSource} type="button">
                  {text.addMarketSource}
                </button>
              </div>
            )}
            {marketCachedAt && !marketLoading && (
              <p className="cache-note">
                {text.marketCacheNote} {formatCachedAt(marketCachedAt)}
              </p>
            )}

            {marketLoading && Object.keys(sourceStates).length > 0 && (
              <div className="market-loading-area">
                <RoseLoader
                  size={180}
                  accent={settings.theme === "light" ? "#2563eb" : "#38bdf8"}
                />
                <SourceStatusPanel countLabel={text.marketItems} states={sourceStates} />
              </div>
            )}

            {visibleMarket.length === 0 && !marketLoading ? (
              <div className="empty-state">
                <strong>{text.marketEmpty}</strong>
                <span>{text.marketEmptyHint}</span>
                {!marketLoading && !settings.githubToken && <span>{text.marketTokenTip}</span>}
              </div>
            ) : visibleMarket.length > 0 ? (
              <div className="market-directory">
                {installedMarketResources.length > 0 && (
                  <section className="market-installed-strip">
                    <div className="market-section-heading">
                      <h3>
                        {text.marketAdded}
                        <span>{installedMarketResources.length}</span>
                      </h3>
                      <button
                        className="link-button"
                        onClick={() => setActiveNav(installedMarketNav)}
                        type="button"
                      >
                        {text.manage}
                      </button>
                    </div>
                    <div className="installed-resource-row">
                      {installedMarketResources.slice(0, 4).map((resource) => (
                        <article
                          aria-label={resource.name}
                          className="installed-resource"
                          key={resource.id}
                          title={resource.name}
                        >
                          <span className={`market-resource-icon ${resource.kind}`}>
                            {resource.name.slice(0, 2).toUpperCase()}
                          </span>
                          <span className="installed-resource-copy">
                            <strong>{resource.name}</strong>
                            <small>{installedResourceSource(resource)}</small>
                          </span>
                          <span className="market-installed">{text.marketInstalled}</span>
                        </article>
                      ))}
                      {installedMarketResources.length > 4 && (
                        <button
                          className="installed-resource installed-resource-more"
                          onClick={() => setActiveNav(installedMarketNav)}
                          type="button"
                        >
                          +{installedMarketResources.length - 4}
                        </button>
                      )}
                    </div>
                  </section>
                )}

                {([
                  [text.marketFeatured, featuredMarket],
                  [text.marketCommunity, communityMarket],
                ] as Array<[string, MarketEntry[]]>).map(([title, entries]) => entries.length > 0 ? (
                  <section className="market-directory-section" key={String(title)}>
                    <h3>{title}</h3>
                    <div className="market-directory-list">
                      {entries.map((entry) => (
                        <article className="market-directory-item" key={entry.sourceUrl}>
                          <span className={`market-resource-icon ${entry.kind}`}>
                            {entry.name.slice(0, 2).toUpperCase()}
                          </span>
                          <div className="market-directory-copy">
                            <div className="market-directory-title">
                              <h4>{entry.name}</h4>
                              <span className={`market-origin ${entry.origin}`}>{originLabel(entry.origin, text)}</span>
                            </div>
                            <p>{entry.summary ?? text.marketNoSummary}</p>
                            <a className="market-link" href={entry.sourceUrl} target="_blank" rel="noreferrer">
                              {entry.repo ?? repoLabel(entry.sourceUrl)}
                            </a>
                          </div>
                          <div className="market-directory-actions">
                            {entry.stars != null && (
                              <span className="market-stars" title={text.starsHint}>
                                ★ {formatStars(entry.stars)}
                              </span>
                            )}
                            <button
                              className={entry.installed ? "ghost compact" : "ghost compact"}
                              disabled={entry.installed || installingUrl === entry.sourceUrl}
                              onClick={() => installFromMarket(entry)}
                              type="button"
                            >
                              {entry.installed
                                ? text.marketInstalled
                                : installingUrl === entry.sourceUrl
                                  ? text.marketLoadingShort
                                  : text.install}
                            </button>
                          </div>
                        </article>
                      ))}
                    </div>
                  </section>
                ) : null)}
                {displayedMarket.length < visibleMarket.length && (
                  <button
                    className="ghost market-load-more"
                    onClick={() => setMarketVisibleCount((count) => count + MARKET_PAGE_SIZE)}
                    type="button"
                  >
                    {text.loadMore} {displayedMarket.length}/{visibleMarket.length}
                  </button>
                )}
              </div>
            ) : null}
          </section>
        ) : activeNav === "settings" ? (
          <section className="settings-panel" aria-label="Settings" ref={settingsPanelRef}>
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

            <div className="settings-grid settings-sections">
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
                  <button className="secondary" onClick={addExtraSkillPath} type="button">
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
                        <button className="danger-small" onClick={() => removeExtraSkillPath(path)} type="button">
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
                  <button className="secondary" onClick={addGithubIndexUrl} type="button">
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
                        <button className="danger-small" onClick={() => removeGithubIndexUrl(url)} type="button">
                          {text.remove}
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </section>

              <section className="setting-card path-card">
                <div>
                  <h2>{text.githubTokenTitle}</h2>
                  <p>{text.githubTokenHint}</p>
                </div>
                <div className="path-entry">
                  <input
                    aria-label={text.githubTokenTitle}
                    type="password"
                    placeholder="ghp_..."
                    value={settings.githubToken}
                    onChange={(event) =>
                      setSettings((current) => ({ ...current, githubToken: event.currentTarget.value }))
                    }
                  />
                  <button
                    className="secondary"
                    onClick={() => setSettings((current) => ({ ...current, githubToken: "" }))}
                    type="button"
                  >
                    {text.clear}
                  </button>
                </div>
              </section>

              <section className="setting-card market-sources-card">
                <div>
                  <h2>{text.marketSourcesTitle}</h2>
                  <p>{text.marketSourcesHint}</p>
                </div>
                <div className="path-list market-source-list">
                  {settings.marketSources.length === 0 ? (
                    <p>{text.noMarketSources}</p>
                  ) : (
                    settings.marketSources.map((url) => (
                      <div className="path-row" key={url}>
                        <span>{url}</span>
                        <button className="danger-small" onClick={() => removeMarketSource(url)} type="button">
                          {text.remove}
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </section>
            </div>
          </section>
        ) : (
          <>
            {activeNav === "overview" && (
              <section className="cards" aria-label="Inventory health">
                <Metric label={text.metrics.skills} value={skillCount} />
                <Metric label={text.metrics.plugins} value={pluginCount} />
                <Metric label={text.metrics.githubTracked} value={githubCount} />
              </section>
            )}

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

            <section className="resource-toolbar" aria-label={text.resourceToolbar}>
              <div className="source-tabs" aria-label={text.sourceFilter}>
                {(["all", "native", "github", "local"] as Array<"all" | SourceKind>).map((source) => {
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
              </div>
              <div className="view-toggle" aria-label={text.viewMode} role="group">
                <button
                  aria-label={text.listView}
                  className={resourceViewMode === "list" ? "active" : ""}
                  onClick={() => setResourceViewMode("list")}
                  title={text.listView}
                  type="button"
                >
                  <List aria-hidden="true" size={18} />
                </button>
                <button
                  aria-label={text.gridView}
                  className={resourceViewMode === "grid" ? "active" : ""}
                  onClick={() => setResourceViewMode("grid")}
                  title={text.gridView}
                  type="button"
                >
                  <Grid2X2 aria-hidden="true" size={18} />
                </button>
              </div>
            </section>

            <section className="content-grid">
              {resourceViewMode === "list" ? (
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
                    <ResourceRow
                      key={resource.id}
                      resource={resource}
                      selected={selected?.id === resource.id}
                      text={text}
                      onSelect={() => {
                        setSelectedId(resource.id);
                        setPendingDelete(false);
                        setSummaryExpanded(false);
                        setUpdateCheck(null);
                        setPendingUpdate(false);
                      }}
                    />
                  ))}
                </div>
              ) : (
                <div className="resource-card-grid" aria-label={text.gridView}>
                  {visibleResources.length === 0 && (
                    <div className="empty-state">
                      <strong>{text.noMatches}</strong>
                      <span>{text.noMatchesHint}</span>
                    </div>
                  )}
                  {visibleResources.map((resource) => (
                    <ResourceCard
                      key={resource.id}
                      resource={resource}
                      selected={selected?.id === resource.id}
                      text={text}
                      onSelect={() => {
                        setSelectedId(resource.id);
                        setPendingDelete(false);
                        setSummaryExpanded(false);
                        setUpdateCheck(null);
                        setPendingUpdate(false);
                      }}
                    />
                  ))}
                </div>
              )}

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
                        {selected.sourceKind === "github" && selected.sourceUrl ? (
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
                    {selected.sourceKind === "github" && selected.sourceUrl && (
                      <section className="update-block">
                        <div className="update-head">
                          <strong>{text.versionCheck}</strong>
                          <button
                            className="link-button"
                            disabled={updateChecking}
                            onClick={checkUpdate}
                            type="button"
                          >
                            {updateChecking ? text.updateChecking : text.checkUpdate}
                          </button>
                        </div>
                        {updateCheck && (
                          <p className={`update-result ${updateCheck.status}`}>
                            {updateStatusBadge(updateCheck.status, text)}
                          </p>
                        )}
                        {updateCheck?.status === "update-available" && (
                          <button className="primary update-apply" onClick={applyUpdate} type="button">
                            {pendingUpdate ? text.confirmUpdate : text.applyUpdate}
                          </button>
                        )}
                      </section>
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
    {showUpdateDialog && (
      <div className="update-dialog-overlay" onClick={() => setShowUpdateDialog(false)}>
        <div className="update-dialog" onClick={(e) => e.stopPropagation()}>
          <h2>{text.appUpdate.available}</h2>
          <p>{text.appUpdate.dialogMessage.replace("{version}", appUpdate.version ?? "")}</p>
          <div className="update-dialog-actions">
            <button className="primary" onClick={() => { setShowUpdateDialog(false); void installAppUpdateNow(); }}>
              {text.appUpdate.installNow}
            </button>
            <button className="ghost" onClick={() => setShowUpdateDialog(false)}>
              {text.appUpdate.skip}
            </button>
          </div>
        </div>
      </div>
    )}
  </>
  );
}

const ROSE_THREE_CONFIG = {
  particleCount: 76,
  trailSpan: 0.31,
  durationMs: 5300,
  rotationDurationMs: 28000,
  pulseDurationMs: 4400,
  strokeWidth: 4.6,
  roseA: 9.2,
  roseABoost: 0.6,
  roseBreathBase: 0.72,
  roseBreathBoost: 0.28,
  roseScale: 3.25,
} as const;

const RoseLoader = memo(function RoseLoader({ size = 160, accent = "#38bdf8" }: { size?: number; accent?: string }) {
  const pathD = useMemo(() => buildRosePath(0.86), []);
  const particleKeyframes = useMemo(() => buildRoseParticleKeyframes(size), [size]);
  const loopSeconds = ROSE_THREE_CONFIG.durationMs / 1000;

  return (
    <div
      aria-label="Rose Three loading animation"
      className="rose-loader"
      role="img"
      style={{ "--rose-accent": accent, height: size, width: size } as CSSProperties}
    >
      <style>{particleKeyframes}</style>
      <svg aria-hidden="true" className="rose-loader-track" viewBox="0 0 100 100">
        <path
          d={pathD}
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={ROSE_THREE_CONFIG.strokeWidth}
        />
      </svg>
      {Array.from({ length: ROSE_THREE_CONFIG.particleCount }, (_, index) => {
        const tailOffset = index / (ROSE_THREE_CONFIG.particleCount - 1);
        const fade = Math.pow(1 - tailOffset, 0.56);
        return (
          <span
            aria-hidden="true"
            className="rose-loader-particle"
            key={index}
            style={
              {
                "--particle-delay": `${-(tailOffset * ROSE_THREE_CONFIG.trailSpan * loopSeconds)}s`,
                "--particle-opacity": 0.04 + fade * 0.96,
                "--particle-size": `${(0.9 + fade * 2.7) * (size / 100)}px`,
              } as CSSProperties
            }
          />
        );
      })}
    </div>
  );
});

function getRosePoint(progress: number, detailScale: number) {
  const t = progress * Math.PI * 2;
  const a = ROSE_THREE_CONFIG.roseA + detailScale * ROSE_THREE_CONFIG.roseABoost;
  const r =
    a *
    (ROSE_THREE_CONFIG.roseBreathBase + detailScale * ROSE_THREE_CONFIG.roseBreathBoost) *
    Math.cos(3 * t);
  return {
    x: 50 + Math.cos(t) * r * ROSE_THREE_CONFIG.roseScale,
    y: 50 + Math.sin(t) * r * ROSE_THREE_CONFIG.roseScale,
  };
}

function buildRosePath(detailScale: number, steps = 480) {
  return Array.from({ length: steps + 1 }, (_, index) => {
    const point = getRosePoint(index / steps, detailScale);
    return `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
  }).join(" ");
}

function buildRoseParticleKeyframes(size: number, steps = 72) {
  const scale = size / 100;
  const frames = Array.from({ length: steps + 1 }, (_, index) => {
    const progress = index / steps;
    const detailScale = roseDetailScaleAtProgress(progress);
    const point = getRosePoint(progress, detailScale);
    return `${(progress * 100).toFixed(3)}% { transform: translate(${(point.x * scale).toFixed(2)}px, ${(point.y * scale).toFixed(2)}px) translate(-50%, -50%); }`;
  });
  return `@keyframes rose-three-particle { ${frames.join("\n")} }`;
}

function roseDetailScaleAtProgress(progress: number) {
  const pulseAngle = progress * Math.PI * 2 * (ROSE_THREE_CONFIG.durationMs / ROSE_THREE_CONFIG.pulseDurationMs);
  return 0.52 + ((Math.sin(pulseAngle + 0.55) + 1) / 2) * 0.48;
}

function SourceStatusPanel({ countLabel, states }: { countLabel: string; states: Record<string, SourceState> }) {
  const entries = Object.entries(states);
  if (entries.length === 0) return null;

  return (
    <div className="source-status-panel">
      {entries.map(([key, state]) => (
        <div className={`source-status-row ${state.status}`} key={key}>
          <span className="source-status-icon">
            {state.status === "loading" ? (
              <span className="source-status-spinner" />
            ) : state.status === "success" ? (
              "✓"
            ) : (
              "✗"
            )}
          </span>
          <span className="source-status-label">{state.label}</span>
          {state.status === "success" && state.count !== undefined && (
            <span className="source-status-count">{state.count} {countLabel}</span>
          )}
          {state.status === "error" && state.error && (
            <span className="source-status-error" title={state.error}>{state.error}</span>
          )}
        </div>
      ))}
    </div>
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

function AppUpdateControl({
  update,
  text,
  onCheck,
  onInstall,
}: {
  update: AppUpdateState;
  text: Labels;
  onCheck: (options?: { background?: boolean }) => Promise<unknown>;
  onInstall: () => Promise<void>;
}) {
  if (!isTauriRuntime()) {
    return null;
  }

  const busy = update.status === "checking" || update.status === "downloading" || update.status === "installing";
  const hasUpdate = update.status === "available" || update.status === "downloading" || update.status === "installing";
  const label = appUpdateButtonLabel(update, text);

  return (
    <div className={hasUpdate ? "app-update has-update" : "app-update"}>
      {update.version && <span className="app-update-version">v{update.version}</span>}
      <button
        className={hasUpdate ? "primary app-update-button" : "ghost app-update-button"}
        disabled={busy}
        onClick={() => {
          if (update.status === "available" || update.status === "error") {
            void onInstall();
            return;
          }
          void onCheck({ background: false });
        }}
        title={update.error ?? undefined}
        type="button"
      >
        {label}
      </button>
    </div>
  );
}

function appUpdateButtonLabel(update: AppUpdateState, text: Labels) {
  if (update.status === "checking") return text.appUpdate.checkingShort;
  if (update.status === "available") return text.appUpdate.installNow;
  if (update.status === "downloading") return `${text.appUpdate.downloadingShort} ${update.progress}%`;
  if (update.status === "installing") return text.appUpdate.installingShort;
  if (update.status === "error") return text.appUpdate.retry;
  return text.appUpdate.check;
}

function ResourceRow({
  resource,
  selected,
  text,
  onSelect,
}: {
  resource: SkillResource;
  selected: boolean;
  text: Labels;
  onSelect: () => void;
}) {
  return (
    <button
      className={selected ? "resource-row selected" : "resource-row"}
      onClick={onSelect}
      type="button"
    >
      <div className="resource-main">
        <div className="resource-title-line">
          <strong>{resource.name}</strong>
          <SourceBadge sourceKind={resource.sourceKind} text={text} />
        </div>
        <small>{compactPath(resource.path)}</small>
      </div>
      <div className="resource-meta">
        <HostChip host={resource.host} />
        <em>{resourceKindLabel(resource.kind, text)}</em>
      </div>
      <span className={`update-pill ${resource.sourceKind}`}>
        {updateStatusLabel(resource.updateStatus, text)}
      </span>
    </button>
  );
}

function ResourceCard({
  resource,
  selected,
  text,
  onSelect,
}: {
  resource: SkillResource;
  selected: boolean;
  text: Labels;
  onSelect: () => void;
}) {
  return (
    <button
      className={selected ? "resource-card selected" : "resource-card"}
      onClick={onSelect}
      type="button"
    >
      <div className="resource-card-head">
        <strong>{resource.name}</strong>
        <SourceBadge sourceKind={resource.sourceKind} text={text} />
      </div>
      <p className="resource-card-summary">{resource.summary || text.noSelection}</p>
      <div className="resource-card-meta">
        <HostChip host={resource.host} />
        <em>{resourceKindLabel(resource.kind, text)}</em>
        <span className={`update-pill ${resource.sourceKind}`}>
          {updateStatusLabel(resource.updateStatus, text)}
        </span>
      </div>
      <small>{compactPath(resource.path)}</small>
    </button>
  );
}

function sourceCount(resources: SkillResource[], source: "all" | SourceKind) {
  return source === "all"
    ? resources.length
    : resources.filter((resource) => matchesSourceGroup(resource.sourceKind, source)).length;
}

function matchesSourceGroup(sourceKind: SourceKind, selectedSource: SourceKind) {
  if (selectedSource === "native") {
    return sourceKind === "native" || sourceKind === "registry";
  }
  if (selectedSource === "local") {
    return sourceKind === "local" || sourceKind === "linked";
  }
  return sourceKind === selectedSource;
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

function HostChip({ host }: { host: HostKind }) {
  return <span className={`chip ${host}`}>{titleCase(host)}</span>;
}

function navItemsFor(
  items: NavView[],
  activeNav: NavView,
  text: Labels,
  onSelect: (item: NavView) => void,
): LimelightNavItem[] {
  return items.map((item) => ({
    id: item,
    icon: navIcon(item),
    label: text.nav[item],
    onClick: () => {
      if (activeNav !== item) {
        onSelect(item);
      }
    },
  }));
}

function navIcon(item: NavView) {
  const icons: Record<NavView, ReactElement<{ className?: string }>> = {
    overview: <LayoutDashboard />,
    skills: <BookOpenCheck />,
    plugins: <Blocks />,
    market: <ShoppingBag />,
    settings: <Settings />,
  };
  return icons[item];
}

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

type Labels = (typeof labels)[Language];

function SourceBadge({ sourceKind, text }: { sourceKind: SkillResource["sourceKind"]; text: Labels }) {
  return <span className={`source-badge ${sourceKind}`}>{sourceLabel(sourceKind, text)}</span>;
}

function sourceLabel(sourceKind: SkillResource["sourceKind"], text: Labels) {
  return text.sourceKinds[sourceKind];
}

function resourceKindLabel(kind: SkillResource["kind"], text: Labels) {
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

function topbarTitle(activeNav: NavView, text: Labels) {
  if (activeNav === "skills") return text.nav.skills;
  if (activeNav === "plugins") return text.nav.plugins;
  if (activeNav === "market") return text.nav.market;
  if (activeNav === "settings") return text.nav.settings;
  return text.inventory;
}

function repoLabel(url: string) {
  return url.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
}

function sourceUrlLabel(url: string) {
  return url.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
}

function installedResourceSource(resource: SkillResource) {
  if (resource.sourceUrl) return repoLabel(resource.sourceUrl);
  if (resource.sourceKind === "native") return "Official";
  if (resource.sourceKind === "local") return "Local";
  if (resource.sourceKind === "linked") return "Linked";
  const parts = pathParts(resource.path);
  if (parts.length > 1) return parts.slice(-2).join("/");
  return resource.sourceKind;
}

function originLabel(origin: string, text: Labels) {
  return text.originLabels[origin] ?? origin;
}

function formatStars(stars: number) {
  if (stars >= 1000) return `${(stars / 1000).toFixed(1)}k`;
  return String(stars);
}

function updateStatusBadge(status: string, text: Labels) {
  return text.updateResultStatuses[status] ?? status;
}

function updateNoticeFor(status: string, text: Labels) {
  return text.updateNotices[status] ?? text.updateChecked;
}

function compactPath(path: string) {
  const compact = compactHomePath(path);
  if (compact.length <= 64) {
    return compact;
  }
  return `...${compact.slice(-61)}`;
}

function rootFromResourcePath(path: string) {
  const normalized = normalizePathSeparators(path);
  const skillsIndex = normalized.toLocaleLowerCase().indexOf("/skills/");
  const pluginsIndex = normalized.toLocaleLowerCase().indexOf("/plugins/");
  const markerIndex = skillsIndex >= 0 ? skillsIndex : pluginsIndex;
  if (markerIndex < 0) return path;
  return path.slice(0, markerIndex);
}

function pathParts(path: string) {
  return normalizePathSeparators(path).split("/").filter(Boolean);
}

function normalizePathSeparators(path: string) {
  return path.replace(/\\/g, "/");
}

function compactHomePath(path: string) {
  const normalized = normalizePathSeparators(path);
  const userHomeMatch = normalized.match(/^([A-Za-z]:)?\/Users\/[^/]+(?=\/|$)/);
  if (userHomeMatch?.[0]) {
    return path.replace(path.slice(0, userHomeMatch[0].length), "~");
  }
  const unixHomeMatch = normalized.match(/^\/home\/[^/]+(?=\/|$)/);
  if (unixHomeMatch?.[0]) {
    return path.replace(path.slice(0, unixHomeMatch[0].length), "~");
  }
  return path;
}

function loadSettings(): AppSettings {
  const defaults: AppSettings = {
    language: "en",
    theme: "dark",
    extraSkillPaths: [],
    githubMatchingEnabled: false,
    githubIndexUrls: [],
    marketSources: [...DEFAULT_MARKET_SOURCES],
    githubToken: "",
    remoteIndexUrl: DEFAULT_REMOTE_INDEX_URL,
    customRegistrySources: [],
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
      // First run and older empty market-source settings both seed the default
      // built-in catalogs so newly bundled sources appear after an app update.
      marketSources: Array.isArray(parsed.marketSources)
        ? normalizeMarketSources(parsed.marketSources)
        : [...DEFAULT_MARKET_SOURCES],
      githubToken: typeof parsed.githubToken === "string" ? parsed.githubToken : "",
      remoteIndexUrl:
        typeof parsed.remoteIndexUrl === "string" && parsed.remoteIndexUrl.trim().length > 0
          ? parsed.remoteIndexUrl
          : DEFAULT_REMOTE_INDEX_URL,
      customRegistrySources: Array.isArray(parsed.customRegistrySources)
        ? parsed.customRegistrySources.filter((url): url is string => typeof url === "string" && url.trim().length > 0)
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

function readMarketCache(settings: AppSettings) {
  try {
    const raw = window.localStorage?.getItem(MARKET_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<MarketCache>;
    if (
      typeof parsed.cachedAt !== "number" ||
      parsed.sourceSignature !== marketSourceSignature(settings) ||
      !Array.isArray(parsed.entries)
    ) {
      return null;
    }
    if (Date.now() - parsed.cachedAt > MARKET_CACHE_TTL_MS) {
      return null;
    }
    return {
      cachedAt: parsed.cachedAt,
      entries: parsed.entries.filter(isMarketEntry).map(normalizeMarketEntry),
    };
  } catch {
    return null;
  }
}

function writeMarketCache(settings: AppSettings, entries: MarketEntry[], cachedAt = Date.now()) {
  try {
    const cache: MarketCache = {
      cachedAt,
      entries,
      sourceSignature: marketSourceSignature(settings),
    };
    window.localStorage?.setItem(MARKET_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Marketplace cache is an optimization; ignore storage failures.
  }
}

function clearMarketCache() {
  try {
    window.localStorage?.removeItem(MARKET_CACHE_KEY);
  } catch {
    // Cache removal is best-effort.
  }
}

function marketSourceSignature(settings: AppSettings) {
  return JSON.stringify({
    sources: [...settings.marketSources].sort(),
    remoteIndexUrl: settings.remoteIndexUrl,
    registrySources: [...settings.customRegistrySources].sort(),
  });
}

function normalizeMarketSources(values: unknown[]) {
  const sources = values.filter((url): url is string => typeof url === "string" && url.trim().length > 0);
  const hasLegacyDefaults = LEGACY_DEFAULT_MARKET_SOURCES.every((source) => sources.includes(source));
  if (sources.length === 0) {
    return [...DEFAULT_MARKET_SOURCES];
  }
  if (hasLegacyDefaults) {
    for (const source of DEFAULT_MARKET_SOURCES) {
      if (!sources.includes(source)) {
        sources.push(source);
      }
    }
  }
  return sources;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function looksLikeGithubUrl(value: string) {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith("https://github.com/") || normalized.startsWith("git@github.com:");
}

function isMarketEntry(value: unknown): value is MarketEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<MarketEntry>;
  return typeof entry.name === "string" && typeof entry.sourceUrl === "string";
}

function normalizeMarketEntry(entry: MarketEntry): MarketEntry {
  return {
    ...entry,
    kind: entry.kind === "plugin" ? "plugin" : "skill",
  };
}

function isFeaturedMarketEntry(entry: MarketEntry) {
  const repo = entry.repo ?? repoLabel(entry.sourceUrl);
  return entry.origin === "official" || repo.startsWith("anthropics/");
}

function formatCachedAt(cachedAt: number) {
  return new Date(cachedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
  appUpdate: {
    available: string;
    check: string;
    checking: string;
    checkingShort: string;
    downloading: string;
    downloadingShort: string;
    installNow: string;
    installing: string;
    installingShort: string;
    retry: string;
    skip: string;
    dialogMessage: string;
    upToDate: string;
  };
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
  loadMore: string;
  metrics: {
    githubTracked: string;
    plugins: string;
    skills: string;
  };
  movedToTrash: string;
  nav: Record<NavView, string>;
  marketSearch: string;
  marketLoading: string;
  marketLoadingShort: string;
  marketLoaded: string;
  marketLoadedFromCache: string;
  marketCacheNote: string;
  marketEmpty: string;
  marketEmptyHint: string;
  marketTokenTip: string;
  marketNeedsIndex: string;
  marketNeedsIndexHint: string;
  marketInstalled: string;
  marketInstalling: string;
  marketNoSummary: string;
  marketSomeSourcesFailed: string;
  marketAllSourcesFailed: string;
  marketSourceTimedOut: string;
  marketItems: string;
  marketKind: string;
  marketKinds: Record<"skill" | "plugin", string>;
  marketKindSubtitles: Record<"skill" | "plugin", string>;
  marketAdded: string;
  marketFeatured: string;
  marketCommunity: string;
  marketFilters: string;
  manage: string;
  curatedCatalog: string;
  pasteUrlLabel: string;
  pasteUrlPlaceholder: string;
  pasteUrlRequired: string;
  pasteUrlInvalid: string;
  discover: string;
  discovering: string;
  discoverFound: string;
  discoverNone: string;
  sortBy: string;
  sortStars: string;
  sortName: string;
  starsHint: string;
  originLabels: Record<string, string>;
  githubTokenTitle: string;
  githubTokenHint: string;
  addMarketSource: string;
  marketSourceUrl: string;
  marketSourcesTitle: string;
  marketSourcesHint: string;
  noMarketSources: string;
  marketSourceAdded: string;
  marketSourceExists: string;
  marketSourceRequired: string;
  marketSourceInvalid: string;
  marketSourceRemoved: string;
  clear: string;
  installTo: string;
  install: string;
  checkUpdate: string;
  versionCheck: string;
  updateChecking: string;
  updateChecked: string;
  applyUpdate: string;
  confirmUpdate: string;
  updating: string;
  updated: string;
  updateResultStatuses: Record<string, string>;
  updateNotices: Record<string, string>;
  noExtraPaths: string;
  noGithubIndexes: string;
  noMatches: string;
  noMatchesHint: string;
  noRoots: string;
  noSelection: string;
  path: string;
  refresh: string;
  remove: string;
  resource: string;
  resourceToolbar: string;
  resourceKinds: Record<SkillResource["kind"], string>;
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
  status: string;
  statuses: Record<string, string>;
  summary: string;
  theme: string;
  themeHint: string;
  type: string;
  unknown: string;
  updateStatus: string;
  updateStatuses: Record<string, string>;
  viewMode: string;
  listView: string;
  gridView: string;
  expand: string;
}> = {
  en: {
    allHosts: "All hosts",
    allKinds: "All kinds",
    allSources: "All",
    addPath: "Add path",
    addIndex: "Add index",
    appUpdate: {
      available: "App update available",
      check: "Check app update",
      checking: "Checking for app updates...",
      checkingShort: "Checking...",
      downloading: "Downloading app update...",
      downloadingShort: "Downloading",
      installNow: "Update now",
      installing: "Installing update and restarting...",
      installingShort: "Installing...",
      retry: "Retry update",
      skip: "Skip",
      dialogMessage: "Version {version} is available. Download now and restart?",
      upToDate: "Skill Hub is up to date.",
    },
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
    loadMore: "Load more",
    metrics: {
      githubTracked: "GitHub",
      plugins: "Plugins",
      skills: "Skills",
    },
    movedToTrash: "moved to trash.",
    nav: {
      overview: "Overview",
      skills: "Skills",
      plugins: "Plugins",
      market: "Market",
      settings: "Settings",
    },
    marketSearch: "Search market or paste a GitHub URL",
    marketLoading: "Loading marketplace from GitHub indexes...",
    marketLoadingShort: "Loading...",
    marketLoaded: "Marketplace loaded.",
    marketLoadedFromCache: "Loaded cached marketplace from",
    marketCacheNote: "Cached market loaded at",
    marketEmpty: "No resources found in configured sources.",
    marketEmptyHint: "Add a GitHub source in Settings, then refresh.",
    marketTokenTip: "Empty on first open is often a GitHub rate limit (60/hour anonymous). Add a token in Settings to fix it.",
    marketNeedsIndex: "No GitHub indexes configured.",
    marketNeedsIndexHint: "Add a public GitHub source under Settings to browse resources.",
    marketInstalled: "Installed",
    marketInstalling: "installing...",
    marketNoSummary: "No description provided.",
    marketSomeSourcesFailed: "some sources failed",
    marketAllSourcesFailed: "All market sources failed.",
    marketSourceTimedOut: "This source took too long to respond.",
    marketItems: "items",
    marketKind: "Type",
    marketKinds: {
      skill: "Skill",
      plugin: "Plugin",
    },
    marketKindSubtitles: {
      skill: "Reusable workflows and instructions for agent tasks.",
      plugin: "Use Codex extensions in the tools you work with.",
    },
    marketAdded: "Added",
    marketFeatured: "Featured",
    marketCommunity: "Community",
    marketFilters: "Market filters",
    manage: "Manage",
    curatedCatalog: "Official Catalog",
    pasteUrlLabel: "Paste a GitHub repo or resource URL",
    pasteUrlPlaceholder: "https://github.com/owner/repo  or  .../tree/main/path/name",
    pasteUrlRequired: "Paste a GitHub URL first.",
    pasteUrlInvalid: "Only public GitHub URLs are supported.",
    discover: "Discover",
    discovering: "Discovering...",
    discoverFound: "Resources discovered",
    discoverNone: "No skill or plugin resources found in that repository.",
    sortBy: "Sort by",
    sortStars: "Stars (leaderboard)",
    sortName: "Name",
    starsHint: "Stars of the source repository (GitHub has no per-skill metric).",
    originLabels: {
      official: "Official",
      community: "Community",
      index: "Index",
    },
    githubTokenTitle: "GitHub token (optional)",
    githubTokenHint: "Stored locally only. Raises the GitHub API limit from 60 to 5000 requests/hour for discovery and stars.",
    addMarketSource: "Add market source",
    marketSourceUrl: "Market source URL",
    marketSourcesTitle: "Market sources",
    marketSourcesHint: "GitHub repositories scanned on refresh. Use the plus button next to Market search to add more.",
    noMarketSources: "No market sources configured.",
    marketSourceAdded: "Market source added.",
    marketSourceExists: "Market source already exists.",
    marketSourceRequired: "Market source URL is required.",
    marketSourceInvalid: "Only public GitHub URLs are supported for market sources.",
    marketSourceRemoved: "Market source removed.",
    clear: "Clear",
    installTo: "Install to",
    install: "Install",
    checkUpdate: "Check for updates",
    versionCheck: "Version check",
    updateChecking: "Checking for updates...",
    updateChecked: "Update check complete.",
    applyUpdate: "Update",
    confirmUpdate: "Confirm update",
    updating: "updating...",
    updated: "updated.",
    updateResultStatuses: {
      "up-to-date": "Up to date",
      "update-available": "Update available",
      unknown: "Could not determine (no remote SKILL.md)",
    },
    updateNotices: {
      "up-to-date": "This skill is up to date.",
      "update-available": "An update is available.",
      unknown: "Could not compare with the remote repository.",
    },
    noExtraPaths: "No extra skill paths configured.",
    noGithubIndexes: "No GitHub indexes configured.",
    noMatches: "No resources match the current filters.",
    noMatchesHint: "Refresh inventory or clear search terms.",
    noRoots: "No configured host roots were found.",
    noSelection: "No resource selected.",
    path: "Path",
    refresh: "Refresh",
    remove: "Remove",
    resource: "Resource",
    resourceToolbar: "Resource toolbar",
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
      linked: "Local",
      local: "Local",
      native: "Official",
      registry: "Official",
    },
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
      linked: "Local",
      managed: "Managed",
      manual: "Manual",
      registry: "Official",
      trackable: "Trackable",
      "github verified": "GitHub verified",
      "github probable": "GitHub probable",
    },
    viewMode: "View mode",
    listView: "List view",
    gridView: "Grid view",
  },
  zh: {
    allHosts: "全部主机",
    allKinds: "全部类型",
    allSources: "全部",
    addPath: "添加路径",
    addIndex: "添加索引",
    appUpdate: {
      available: "发现应用更新",
      check: "检查应用更新",
      checking: "正在检查应用更新...",
      checkingShort: "检查中...",
      downloading: "正在下载应用更新...",
      downloadingShort: "下载中",
      installNow: "立即更新",
      installing: "正在安装更新并重启...",
      installingShort: "安装中...",
      retry: "重试更新",
      skip: "跳过",
      dialogMessage: "发现新版本 {version}，立即下载并重启？",
      upToDate: "Skill Hub 已是最新版本。",
    },
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
    loadMore: "加载更多",
    metrics: {
      githubTracked: "GitHub",
      plugins: "插件",
      skills: "Skills",
    },
    movedToTrash: "已移到废纸篓。",
    nav: {
      overview: "总览",
      skills: "Skills",
      plugins: "Plugins",
      market: "市场",
      settings: "设置",
    },
    marketSearch: "搜索市场，或粘贴 GitHub 链接",
    marketLoading: "正在从 GitHub 索引加载市场...",
    marketLoadingShort: "加载中...",
    marketLoaded: "市场已加载。",
    marketLoadedFromCache: "已使用本地市场缓存，缓存时间",
    marketCacheNote: "市场缓存时间",
    marketEmpty: "配置的市场源里没有找到资源。",
    marketEmptyHint: "在设置里添加 GitHub 市场源，然后刷新。",
    marketTokenTip: "首次打开为空通常是 GitHub 限速（匿名 60 次/小时）。在设置里填一个 Token 即可解决。",
    marketNeedsIndex: "还没有配置 GitHub 索引。",
    marketNeedsIndexHint: "在设置里添加公开 GitHub 市场源，即可浏览资源。",
    marketInstalled: "已安装",
    marketInstalling: "安装中...",
    marketNoSummary: "暂无描述。",
    marketSomeSourcesFailed: "部分源加载失败",
    marketAllSourcesFailed: "所有市场源加载失败。",
    marketSourceTimedOut: "这个源响应太慢，已跳过。",
    marketItems: "项",
    marketKind: "类型",
    marketKinds: {
      skill: "Skill",
      plugin: "插件",
    },
    marketKindSubtitles: {
      skill: "给智能体任务复用的工作流和指令。",
      plugin: "在常用工具中使用 Codex 扩展。",
    },
    marketAdded: "已添加",
    marketFeatured: "Featured",
    marketCommunity: "社区",
    marketFilters: "市场筛选",
    manage: "管理",
    curatedCatalog: "官方目录",
    pasteUrlLabel: "粘贴 GitHub 仓库或资源链接",
    pasteUrlPlaceholder: "https://github.com/owner/repo  或  .../tree/main/path/名称",
    pasteUrlRequired: "请先粘贴 GitHub 链接。",
    pasteUrlInvalid: "只支持公开的 GitHub 链接。",
    discover: "发现",
    discovering: "发现中...",
    discoverFound: "发现到的资源数",
    discoverNone: "该仓库里没有找到 Skill 或插件资源。",
    sortBy: "排序",
    sortStars: "Star 数(排行榜)",
    sortName: "名称",
    starsHint: "来源仓库的 star 数(GitHub 没有 skill 粒度的热度指标)。",
    originLabels: {
      official: "官方",
      community: "社区",
      index: "索引",
    },
    githubTokenTitle: "GitHub Token(可选)",
    githubTokenHint: "仅保存在本地。填写后可把 GitHub API 限制从 60 次/小时提升到 5000 次/小时,用于发现和 star。",
    addMarketSource: "添加市场源",
    marketSourceUrl: "市场源 URL",
    marketSourcesTitle: "市场源",
    marketSourcesHint: "刷新市场时扫描的 GitHub 仓库。需要新增时，点市场搜索框旁边的加号。",
    noMarketSources: "还没有配置市场源。",
    marketSourceAdded: "市场源已添加。",
    marketSourceExists: "市场源已存在。",
    marketSourceRequired: "请输入市场源 URL。",
    marketSourceInvalid: "市场源只支持公开 GitHub 链接。",
    marketSourceRemoved: "市场源已移除。",
    clear: "清除",
    installTo: "安装到",
    install: "安装",
    checkUpdate: "检查更新",
    versionCheck: "版本检查",
    updateChecking: "正在检查更新...",
    updateChecked: "更新检查完成。",
    applyUpdate: "更新",
    confirmUpdate: "确认更新",
    updating: "更新中...",
    updated: "已更新。",
    updateResultStatuses: {
      "up-to-date": "已是最新",
      "update-available": "有可用更新",
      unknown: "无法判断（远程没有 SKILL.md）",
    },
    updateNotices: {
      "up-to-date": "该 Skill 已是最新版本。",
      "update-available": "发现可用更新。",
      unknown: "无法与远程仓库对比。",
    },
    noExtraPaths: "还没有配置额外路径。",
    noGithubIndexes: "还没有配置 GitHub 索引。",
    noMatches: "没有符合当前筛选条件的资源。",
    noMatchesHint: "刷新资源库，或清空搜索条件。",
    noRoots: "没有找到已配置的主机根目录。",
    noSelection: "未选择资源。",
    path: "路径",
    refresh: "刷新",
    remove: "移除",
    resource: "资源",
    resourceToolbar: "资源工具栏",
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
      linked: "本地",
      local: "本地",
      native: "官方",
      registry: "官方",
    },
    status: "状态",
    statuses: {
      incompatible: "不兼容",
      ready: "就绪",
      warning: "注意",
    },
    summary: "摘要",
    theme: "主题",
    themeHint: "切换界面外观，不影响已经扫描到的资源。",
    type: "类型",
    unknown: "未知",
    updateStatus: "更新状态",
    updateStatuses: {
      linked: "本地",
      managed: "托管",
      manual: "手动",
      registry: "官方",
      trackable: "可跟踪",
      "github verified": "GitHub 已验证",
      "github probable": "GitHub 可能匹配",
    },
    viewMode: "视图模式",
    listView: "列表视图",
    gridView: "方块视图",
  },
};

export default App;
