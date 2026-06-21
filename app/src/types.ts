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

export interface InventoryFilters {
  kind: "all" | ResourceKind;
  host: "all" | HostKind;
  source: "all" | SourceKind;
  query: string;
}
