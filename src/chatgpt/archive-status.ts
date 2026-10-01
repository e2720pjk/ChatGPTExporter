import type { ArchiveFileSystem } from "../core/filesystem";
import { sha256Hex } from "../core/hash";
import { safePathSegment } from "../core/paths";
import { currentExportInventory } from "../core/selection";
import { parseJson } from "../core/serialization";
import type { ArchiveManifest, ConversationInventory, ProjectAssetIndex } from "../core/types";
import type { ArchiveAuditReport } from "./audit";

export interface IndexedConversationStatus {
  conversationId: string;
  selectedForCurrentExport: boolean;
}

export interface ArchivedProjectStatus {
  projectId: string;
  name: string | null;
  discoveredConversationCount: number;
  discoveredFileCount: number;
  selectedForCurrentExport: boolean;
  savedConversationCount?: number | undefined;
  savedFileCount?: number;
  fileStatus: "complete" | "partial" | "not_requested" | "unavailable";
}

export interface ArchiveFolderStatus {
  kind: "new" | "inventory_only" | "archive" | "unavailable";
  workspaceFingerprint?: string;
  inventory?: ConversationInventory;
  conversations?: IndexedConversationStatus[];
  projects: ArchivedProjectStatus[];
  lastAudit?: Pick<ArchiveAuditReport, "terminalState" | "auditedAt" | "expectedConversationCount" | "completeConversationCount">;
  /** Verifies small authoritative artifacts, not conversation bodies or asset bytes. */
  auditMatchesInventory: boolean;
  warnings: string[];
}

/** Read-only: no recursive scan, body reads, provider requests, or persistent summary. */
export async function readArchiveFolderStatus(filesystem: ArchiveFileSystem): Promise<ArchiveFolderStatus> {
  const result: ArchiveFolderStatus = { kind: "new", projects: [], auditMatchesInventory: false, warnings: [] };
  try {
    const [manifestText, inventoryText, indexText, auditText] = await Promise.all(
      ["archive.json", "inventory.json", "indexes/conversations.jsonl", "reports/validation.json"].map((path) => filesystem.readText(path)),
    );
    if ([manifestText, inventoryText, indexText, auditText].every((text) => text === undefined)) return result;
    const manifest = parseJson<ArchiveManifest>(manifestText);
    const inventory = parseJson<ConversationInventory>(inventoryText);
    const validManifest = manifest?.schemaVersion === 1 && manifest.provider === "chatgpt-web" && typeof manifest.workspaceFingerprint === "string";
    const validInventory = inventory?.schemaVersion === 1 && inventory.provider === "chatgpt-web"
      && typeof inventory.workspaceFingerprint === "string" && Array.isArray(inventory.conversations) && Array.isArray(inventory.chains);
    result.kind = validManifest ? "archive" : validInventory ? "inventory_only" : "unavailable";
    if (validManifest) result.workspaceFingerprint = manifest.workspaceFingerprint;
    else if (validInventory) result.workspaceFingerprint = inventory.workspaceFingerprint;
    if (manifestText !== undefined && !validManifest) result.warnings.push("archive.json is unreadable or unsupported.");
    if (inventoryText !== undefined && !validInventory) result.warnings.push("inventory.json is unreadable or unsupported.");
    if (validManifest && validInventory && manifest.workspaceFingerprint !== inventory.workspaceFingerprint) {
      result.kind = "unavailable";
      result.warnings.push("Manifest and inventory workspace identities differ. Do not resume into this folder.");
      return result;
    }
    let selected: ConversationInventory | undefined;
    if (validInventory) {
      selected = currentExportInventory(inventory);
      result.inventory = inventory;
    }
    const hashes = validManifest ? manifest.currentIndexHashes : undefined;
    const inventoryVerified = inventoryText !== undefined && typeof hashes?.inventory === "string"
      && await sha256Hex(inventoryText) === hashes.inventory;
    if (hashes?.inventory && !inventoryVerified) result.warnings.push("Inventory has changed since the recorded audit.");
    if (indexText !== undefined) {
      if (typeof hashes?.conversations !== "string" || await sha256Hex(indexText) !== hashes.conversations) {
        result.warnings.push("Conversation index hash is missing or mismatched; saved counts are unavailable.");
      } else {
        const rows = indexText.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as Record<string, unknown>);
        if (rows.some((row) => typeof row.conversationId !== "string" || (row.workspaceFingerprint !== undefined ? row.workspaceFingerprint !== result.workspaceFingerprint : row.logicalKey !== `${result.workspaceFingerprint}/${row.conversationId}`))) {
          result.warnings.push("Conversation index identities are invalid; saved counts are unavailable.");
        } else {
          result.conversations = rows.map((row) => ({
            conversationId: String(row.conversationId),
            selectedForCurrentExport: typeof row.selectedForCurrentExport === "boolean" ? row.selectedForCurrentExport : row.absentFromCurrentInventory !== true,
          }));
        }
      }
    }
    const audit = parseJson<ArchiveAuditReport>(auditText);
    const validAudit = audit?.schemaVersion === 1 && audit.workspaceFingerprint === result.workspaceFingerprint
      && ["complete", "conversations_complete_assets_partial", "incomplete"].includes(audit.terminalState)
      && typeof audit.auditedAt === "string";
    if (validAudit) {
      result.lastAudit = {
        terminalState: audit.terminalState, auditedAt: audit.auditedAt,
        expectedConversationCount: audit.expectedConversationCount, completeConversationCount: audit.completeConversationCount,
      };
      result.auditMatchesInventory = inventoryVerified && result.conversations !== undefined
        && typeof hashes?.validation === "string" && await sha256Hex(auditText!) === hashes.validation;
      if (!result.auditMatchesInventory) result.warnings.push("Audit freshness is unknown; run Revalidate after capture/resume. Legacy manifests may lack artifact hashes.");
    } else if (auditText !== undefined) result.warnings.push("Validation report is unreadable or belongs to another workspace.");
    const savedIds = result.conversations && new Set(result.conversations.map((row) => row.conversationId));
    const selectedProjects = new Set(selected?.projects?.map((project) => project.projectId));
    // ponytail: O(projects × conversations); pre-index memberships if large inventories make status reads slow.
    for (const project of result.inventory?.projects ?? []) {
      const members = inventory!.conversations.filter((conversation) => conversation.memberships.some((membership) => membership.scope === "project" && membership.projectId === project.projectId));
      const status: ArchivedProjectStatus = {
        projectId: project.projectId, name: project.name,
        discoveredConversationCount: members.length, discoveredFileCount: project.files.length,
        selectedForCurrentExport: selectedProjects.has(project.projectId),
        savedConversationCount: savedIds ? members.filter((member) => savedIds.has(member.conversationId)).length : undefined,
        fileStatus: "unavailable",
      };
      const base = `projects/${safePathSegment(project.projectId)}`;
      const marker = parseJson<{ schemaVersion: number; provider: string; projectId: string; assetsHash: string; status: ArchivedProjectStatus["fileStatus"] }>(await filesystem.readText(`${base}/complete.json`));
      const assetsText = await filesystem.readText(`${base}/assets.json`);
      const assets = parseJson<ProjectAssetIndex>(assetsText);
      if (marker?.schemaVersion === 1 && marker.provider === "chatgpt-web" && marker.projectId === project.projectId
        && assets?.schemaVersion === 1 && assets.projectId === project.projectId
        && Array.isArray(assets.assets) && assetsText !== undefined && await sha256Hex(assetsText) === marker.assetsHash
        && ["complete", "partial", "not_requested"].includes(marker.status)) {
        status.fileStatus = marker.status;
        status.savedFileCount = assets.assets.filter((asset) => asset.status === "complete").length;
      }
      result.projects.push(status);
    }
    return result;
  } catch (error) {
    result.kind = "unavailable";
    result.auditMatchesInventory = false;
    result.warnings.push(error instanceof Error ? error.message : "Archive artifacts are unavailable.");
    return result;
  }
}
