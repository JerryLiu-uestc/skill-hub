export type HostKind = "codex" | "claude";
export type ResourceKind = "skill" | "plugin" | "unknown";
export type ResourceStatus = "ready" | "warning" | "incompatible";
export type SourceKind = "native" | "github" | "local" | "linked" | "registry";

export interface SkillResource {
  id: string;
  name: string;
  kind: ResourceKind;
  host: HostKind;
  status: ResourceStatus;
  path: string;
  summary: string;
  compatibility: string[];
  warnings: string[];
  sourceKind: SourceKind;
  sourceUrl: string | null;
  updateStatus: string;
}

export interface GitHubSourceMatch {
  resourceId: string;
  sourceUrl: string;
  confidence: "verified" | "probable" | string;
  matchedBy: string;
}

export interface MarketEntry {
  name: string;
  kind: Exclude<ResourceKind, "unknown">;
  summary: string | null;
  sourceUrl: string;
  skillSha256: string | null;
  installed: boolean;
  installedId: string | null;
  repo: string | null;
  stars: number | null;
  origin: "official" | "community" | "index" | string;
  categories?: string[];
  hotness?: number;
  description?: string;
  updatedAt?: string;
  indexId?: string;
}

export interface MarketResult {
  entries: MarketEntry[];
  warnings: string[];
}

export type UpdateStatusKind = "up-to-date" | "update-available" | "unknown" | string;

export interface UpdateCheck {
  status: UpdateStatusKind;
  sourceUrl: string;
  localSha256: string | null;
  remoteSha256: string | null;
  detail: string | null;
}

export interface InventoryFilters {
  kind: "all" | ResourceKind;
  host: "all" | HostKind;
  source: "all" | SourceKind;
  query: string;
}
