import type { ConversationInventory, ScopeMembership } from "./types";

/** An excluded project wins over every other listing membership, including main/shared. */
export function currentExportInventory(inventory: ConversationInventory): ConversationInventory {
  const selection = inventory.projectSelection;
  if (selection !== undefined && (!selection || !Array.isArray(selection.excludedProjectIds)
    || !selection.excludedProjectIds.every((id) => typeof id === "string" && id.length > 0))) {
    throw new Error("Invalid project selection in inventory.json.");
  }
  const excluded = new Set(selection?.excludedProjectIds ?? []);
  return {
    ...inventory,
    projects: (inventory.projects ?? []).filter((project) => !excluded.has(project.projectId)),
    conversations: inventory.conversations.filter((conversation) =>
      !conversation.memberships.some((membership) =>
        membership.scope === "project" && membership.projectId !== undefined && excluded.has(membership.projectId))),
  };
}

export function sameMemberships(left: ScopeMembership[], right: ScopeMembership[]): boolean {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  const keys = (memberships: ScopeMembership[]) =>
    memberships.map(({ scope, projectId, projectName, shareId }) => JSON.stringify([scope, projectId ?? null, projectName ?? null, shareId ?? null])).sort();
  return JSON.stringify(keys(left)) === JSON.stringify(keys(right));
}
