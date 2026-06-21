import type { InventoryFilters, SkillResource } from "./types";

export function filterInventory(
  resources: SkillResource[],
  filters: InventoryFilters,
): SkillResource[] {
  const query = filters.query.trim().toLocaleLowerCase();

  return resources.filter((resource) => {
    if (filters.kind !== "all" && resource.kind !== filters.kind) {
      return false;
    }
    if (filters.host !== "all" && resource.host !== filters.host) {
      return false;
    }
    if (filters.source !== "all" && resource.sourceKind !== filters.source) {
      return false;
    }
    if (!query) {
      return true;
    }

    const searchable = [
      resource.name,
      resource.kind,
      resource.host,
      resource.status,
      resource.path,
      resource.summary,
      resource.sourceKind,
      resource.sourceUrl ?? "",
      resource.updateStatus,
      ...resource.compatibility,
      ...resource.warnings,
    ]
      .join(" ")
      .toLocaleLowerCase();

    return searchable.includes(query);
  });
}
