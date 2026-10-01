import { describe, expect, it, vi } from "vitest";

import { auditArchive } from "../../src/chatgpt/audit";
import { ChatGptCaptureEngine } from "../../src/chatgpt/capture-engine";
import type { ChatGptTransport, DiscoveredWorkspace } from "../../src/chatgpt/client";
import type { ChatGptOperationParameters } from "../../src/chatgpt/endpoints";
import { ChatGptInventoryEngine, DEFAULT_INVENTORY_SETTINGS, runWorkspaceInventories, saveProjectSelection } from "../../src/chatgpt/inventory";
import { MemoryArchiveFileSystem } from "../../src/core/filesystem";
import { sha256Hex } from "../../src/core/hash";
import { prettyJson } from "../../src/core/serialization";
import { currentExportInventory } from "../../src/core/selection";
import { readArchiveFolderStatus } from "../../src/chatgpt/archive-status";
import type { JsonValue } from "../../src/core/types";
import { BRIDGE_PROTOCOL_VERSION, type ApiSuccessResponse } from "../../src/extension/protocol";
import { conversationDetail } from "../fixtures/chatgpt";

const workspace: DiscoveredWorkspace = {
  accountId: "account-1",
  workspaceFingerprint: "a".repeat(32),
  label: "Synthetic",
  kind: "personal",
  deactivated: false,
};

describe("deterministic full-scope export integration", () => {
  it("inventories every scope, recovers an omitted batch record, captures content/assets, audits, and repeats byte-identically", async () => {
    const filesystem = new MemoryArchiveFileSystem();
    const transport = fullTransport();
    const inventory = await new ChatGptInventoryEngine({
      transport,
      filesystem,
      workspace,
      settings: { ...DEFAULT_INVENTORY_SETTINGS, pageSize: 2 },
      now: () => new Date("2026-08-01T00:00:00.000Z"),
    }).run();
    expect(inventory).toMatchObject({ complete: true });
    expect(inventory.pages.length).toBe(7);
    expect(inventory.projects?.map((project) => [project.projectId, project.files.length])).toEqual([["project-1", 0], ["project-2", 1]]);
    expect(inventory.conversations).toHaveLength(6);
    expect(inventory.conversations.find((item) => item.conversationId === "conversation-1")?.memberships.map((item) => item.scope).sort())
      .toEqual(["main", "project", "shared"]);

    const result = await new ChatGptCaptureEngine({
      transport,
      filesystem,
      workspace,
      runId: "full-export",
      batchSize: 3,
      now: () => new Date("2026-08-01T00:00:01.000Z"),
    }).run();
    expect(result).toMatchObject({
      inventoryCount: 6,
      capturedCount: 6,
      failedCount: 0,
      partialAssetCount: 0,
      projectAssetCount: 1,
      partialProjectAssetCount: 0,
      accountArtifactStatus: "complete",
    });
    expect(transport.request.mock.calls.filter(([operation]) => operation.operation === "conversation_detail"))
      .toHaveLength(1);
    const audit = await auditArchive({ filesystem, extensionVersion: "0.0.0-test", now: () => new Date("2026-08-01T00:00:02.000Z") });
    expect(audit).toMatchObject({
      terminalState: "complete",
      expectedConversationCount: 6,
      completeConversationCount: 6,
      projectCount: 2,
      logicalAssetReferenceCount: 4,
      physicalAssetCount: 4,
      partialAssetReferenceCount: 0,
    });
    const authoritativeBefore = await authoritativeHash(filesystem);

    const repeatTransport = fullTransport();
    const repeat = await new ChatGptCaptureEngine({
      transport: repeatTransport,
      filesystem,
      workspace,
      runId: "full-export-repeat",
      batchSize: 3,
      now: () => new Date("2026-08-01T00:00:03.000Z"),
    }).run();
    expect(repeat).toMatchObject({ capturedCount: 0, rebuiltCount: 0, skippedCount: 6, failedCount: 0 });
    expect(repeatTransport.request).not.toHaveBeenCalled();
    expect(await authoritativeHash(filesystem)).toBe(authoritativeBefore);
  });

  it("keeps identical provider IDs isolated across selected workspaces and accepts a recognized empty workspace", async () => {
    const first = new MemoryArchiveFileSystem();
    const second = new MemoryArchiveFileSystem();
    const emptyWorkspace: DiscoveredWorkspace = {
      ...workspace,
      accountId: "account-empty",
      workspaceFingerprint: "b".repeat(32),
      label: "Empty",
    };
    const transport = workspaceTransport();
    const results = await runWorkspaceInventories({
      transport,
      targets: [{ workspace, filesystem: first }, { workspace: emptyWorkspace, filesystem: second }],
      settings: { ...DEFAULT_INVENTORY_SETTINGS, includeArchived: false, includeProjects: false, includeShared: false },
    });
    expect(results.get(workspace.workspaceFingerprint)?.conversations[0]?.logicalKey).toBe(`${workspace.workspaceFingerprint}/same-id`);
    expect(results.get(emptyWorkspace.workspaceFingerprint)?.conversations).toEqual([]);
    const emptyCapture = await new ChatGptCaptureEngine({
      transport,
      filesystem: second,
      workspace: emptyWorkspace,
      runId: "empty",
      includeAssets: false,
      includeAccountArtifacts: false,
    }).run();
    expect(emptyCapture).toMatchObject({ inventoryCount: 0, capturedCount: 0, failedCount: 0 });
    expect((await auditArchive({ filesystem: second, extensionVersion: "0.0.0-test" })).terminalState).toBe("complete");
  });

  it("excludes project membership even across main/archived/shared and another selected project before capture", async () => {
    const filesystem = new MemoryArchiveFileSystem();
    const discovery = await new ChatGptInventoryEngine({ transport: fullTransport(true), filesystem, workspace, settings: DEFAULT_INVENTORY_SETTINGS }).run();
    expect(discovery.projects).toHaveLength(2);
    await saveProjectSelection(filesystem, discovery, ["project-2"]);
    const transport = fullTransport(true);
    expect(await new ChatGptCaptureEngine({ transport, filesystem, workspace, runId: "selected", includeAccountArtifacts: false }).run())
      .toMatchObject({ inventoryCount: 4, capturedCount: 4, failedCount: 0, projectAssetCount: 0 });
    const batches = transport.request.mock.calls.filter(([operation]) => operation.operation === "conversation_batch");
    expect(batches.flatMap(([operation]) => operation.parameters.conversationIds!)).toEqual(["conversation-3", "conversation-4", "project-only"]);
    expect(transport.request.mock.calls.filter(([operation]) => operation.operation === "asset_open" || operation.operation === "conversation_detail")).toHaveLength(0);
    for (const id of ["conversation-1", "conversation-2"]) expect(await filesystem.exists(`conversations/${id}/complete.json`)).toBe(false);
    expect(await filesystem.exists("projects/project-2/assets.json")).toBe(false);
    expect(await auditArchive({ filesystem, extensionVersion: "test" })).toMatchObject({
      terminalState: "complete", expectedConversationCount: 4, projectCount: 1, discoveredConversationCount: 6, discoveredProjectCount: 2,
    });
    expect(await filesystem.listPaths("source/batches")).toHaveLength(1);
  });

  it("retains excluded existing bytes and publishes generic current-selection indexes; reselect reuses completion markers", async () => {
    const filesystem = new MemoryArchiveFileSystem();
    const discovery = await new ChatGptInventoryEngine({ transport: fullTransport(), filesystem, workspace, settings: DEFAULT_INVENTORY_SETTINGS }).run();
    await new ChatGptCaptureEngine({ transport: fullTransport(), filesystem, workspace, runId: "all" }).run();
    await auditArchive({ filesystem, extensionVersion: "test" });
    const legacySnapshot = prettyJson(discovery);
    const legacySnapshotPath = `indexes/inventory-snapshots/${await sha256Hex(legacySnapshot)}.json`;
    await filesystem.writeTextAtomic(legacySnapshotPath, legacySnapshot);
    const preservedPaths = (await filesystem.listPaths()).filter((path) => ["conversations/", "projects/", "assets/", "source/", "indexes/inventory-snapshots/"].some((prefix) => path.startsWith(prefix)));
    const preserved = new Map(await Promise.all(preservedPaths.map(async (path) => [path, await sha256Hex((await filesystem.readBytes(path))!)] as const)));
    const selected = await saveProjectSelection(filesystem, discovery, ["project-1", "project-2"]);
    const transport = fullTransport();
    expect(await new ChatGptCaptureEngine({ transport, filesystem, workspace, runId: "exclude" }).run())
      .toMatchObject({ inventoryCount: 4, skippedCount: 4, capturedCount: 0, rebuiltCount: 0 });
    expect(transport.request).not.toHaveBeenCalled();
    expect(await auditArchive({ filesystem, extensionVersion: "test" })).toMatchObject({
      terminalState: "complete", expectedConversationCount: 4, extraRetainedConversationCount: 2, projectCount: 0,
    });
    const rows = (await filesystem.readText("indexes/conversations.jsonl"))!.trim().split("\n").map((line) => JSON.parse(line));
    expect(rows.filter((row) => row.selectedForCurrentExport)).toHaveLength(4);
    expect(rows.find((row) => row.conversationId === "conversation-1")).toMatchObject({
      selectedForCurrentExport: false, excludedByProjectSelection: true, absentFromCurrentInventory: false,
    });
    const assetRows = (await filesystem.readText("indexes/assets.jsonl"))!.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(assetRows.every((row) => row.selectedForCurrentExport && row.projectId === undefined && row.conversationId !== "conversation-1")).toBe(true);
    for (const [path, hash] of preserved) expect(await sha256Hex((await filesystem.readBytes(path))!)).toBe(hash);
    const status = await readArchiveFolderStatus(filesystem);
    expect(status).toMatchObject({ kind: "archive", auditMatchesInventory: true });
    expect(status.projects.find((project) => project.projectId === "project-2")).toMatchObject({ selectedForCurrentExport: false, savedFileCount: 1, fileStatus: "complete" });
    await saveProjectSelection(filesystem, selected, []);
    const rerun = fullTransport();
    expect(await new ChatGptCaptureEngine({ transport: rerun, filesystem, workspace, runId: "reselect" }).run()).toMatchObject({ inventoryCount: 6, skippedCount: 6 });
    expect(rerun.request).not.toHaveBeenCalled();
    expect(await auditArchive({ filesystem, extensionVersion: "test" })).toMatchObject({ terminalState: "complete", extraRetainedConversationCount: 0 });
    expect(await filesystem.readText(legacySnapshotPath)).toBe(legacySnapshot);
  });

  it("isolates selection between workspaces with identical provider project IDs", async () => {
    const first = new MemoryArchiveFileSystem();
    const second = new MemoryArchiveFileSystem();
    const other = { ...workspace, accountId: "account-other", workspaceFingerprint: "c".repeat(32) };
    const inventories = await runWorkspaceInventories({ transport: fullTransport(), settings: DEFAULT_INVENTORY_SETTINGS, targets: [{ workspace, filesystem: first }, { workspace: other, filesystem: second }] });
    await saveProjectSelection(first, inventories.get(workspace.workspaceFingerprint)!, ["project-1"]);
    await saveProjectSelection(second, inventories.get(other.workspaceFingerprint)!, ["project-2"]);
    expect(await new ChatGptCaptureEngine({ transport: fullTransport(), filesystem: first, workspace, runId: "first" }).run()).toMatchObject({ inventoryCount: 4, projectAssetCount: 1 });
    expect(await new ChatGptCaptureEngine({ transport: fullTransport(), filesystem: second, workspace: other, runId: "second" }).run()).toMatchObject({ inventoryCount: 6, projectAssetCount: 0 });
    expect(await first.exists("conversations/conversation-1/complete.json")).toBe(false);
    expect(await second.exists("conversations/conversation-1/complete.json")).toBe(true);
    expect(await first.exists("projects/project-2/complete.json")).toBe(true);
    expect(await second.exists("projects/project-2/complete.json")).toBe(false);
    for (const filesystem of [first, second]) expect((await auditArchive({ filesystem, extensionVersion: "test" })).terminalState).toBe("complete");
  });

  it("rebuilds membership-only changes from valid raw instead of accepting stale normalized memberships", async () => {
    const filesystem = new MemoryArchiveFileSystem();
    const discovery = await new ChatGptInventoryEngine({ transport: fullTransport(), filesystem, workspace, settings: DEFAULT_INVENTORY_SETTINGS }).run();
    await new ChatGptCaptureEngine({ transport: fullTransport(), filesystem, workspace, runId: "all" }).run();
    discovery.conversations.find((conversation) => conversation.conversationId === "conversation-2")!.memberships.push({ scope: "project", projectId: "project-1", projectName: "One" });
    await filesystem.writeTextAtomic("inventory.json", prettyJson(discovery));
    expect((await auditArchive({ filesystem, extensionVersion: "test" })).findings.some((finding) => finding.code === "CONVERSATION_INVENTORY_MISMATCH")).toBe(true);
    const transport = fullTransport();
    expect(await new ChatGptCaptureEngine({ transport, filesystem, workspace, runId: "membership-rebuild" }).run()).toMatchObject({ rebuiltCount: 1, skippedCount: 5, capturedCount: 0 });
    expect(transport.request).not.toHaveBeenCalled();
    expect((await auditArchive({ filesystem, extensionVersion: "test" })).terminalState).toBe("complete");
    const selected = await saveProjectSelection(filesystem, discovery, ["project-1"]);
    expect(currentExportInventory(selected).conversations.map((item) => item.conversationId)).not.toContain("conversation-2");
  });

  it("resumes interrupted selected capture without fetching excluded IDs or duplicating shared batch CAS", async () => {
    const filesystem = new MemoryArchiveFileSystem();
    const discovery = await new ChatGptInventoryEngine({ transport: fullTransport(), filesystem, workspace, settings: DEFAULT_INVENTORY_SETTINGS }).run();
    await saveProjectSelection(filesystem, discovery, ["project-1", "project-2"]);
    const write = filesystem.writeTextAtomic.bind(filesystem);
    let interrupted = false;
    const spy = vi.spyOn(filesystem, "writeTextAtomic").mockImplementation(async (path, content) => {
      if (!interrupted && path === "conversations/share_share-only/conversation.md") { interrupted = true; throw new Error("Interrupted derived write"); }
      await write(path, content);
    });
    const initial = fullTransport();
    await expect(new ChatGptCaptureEngine({ transport: initial, filesystem, workspace, runId: "interrupted", includeAccountArtifacts: false }).run()).rejects.toThrow("Interrupted derived write");
    spy.mockRestore();
    const batches = initial.request.mock.calls.filter(([operation]) => operation.operation === "conversation_batch");
    expect(batches.flatMap(([operation]) => operation.parameters.conversationIds!)).not.toContain("conversation-1");
    expect(batches.flatMap(([operation]) => operation.parameters.conversationIds!)).not.toContain("project-only");
    const resume = fullTransport();
    expect(await new ChatGptCaptureEngine({ transport: resume, filesystem, workspace, runId: "resume", includeAccountArtifacts: false }).run()).toMatchObject({ inventoryCount: 4, rebuiltCount: 1, skippedCount: 3, failedCount: 0 });
    expect(resume.request).not.toHaveBeenCalled();
    expect(await filesystem.listPaths("source/batches")).toHaveLength(1);
    expect((await auditArchive({ filesystem, extensionVersion: "test" })).terminalState).toBe("complete");
  });

  it("fails closed on malformed selection and rejects unknown projects / stale discovery on confirm", async () => {
    const filesystem = new MemoryArchiveFileSystem();
    const discovery = await new ChatGptInventoryEngine({ transport: fullTransport(), filesystem, workspace, settings: DEFAULT_INVENTORY_SETTINGS }).run();
    await expect(saveProjectSelection(filesystem, discovery, ["unknown-project"])).rejects.toThrow("undiscovered");
    await filesystem.writeTextAtomic("inventory.json", prettyJson({ ...discovery, generatedAt: "changed" }));
    await expect(saveProjectSelection(filesystem, discovery, [])).rejects.toThrow("Inventory changed");
    await filesystem.writeTextAtomic("inventory.json", prettyJson({ ...discovery, projectSelection: { excludedProjectIds: "invalid" } }));
    const transport = fullTransport();
    await expect(new ChatGptCaptureEngine({ transport, filesystem, workspace, runId: "invalid" }).run()).rejects.toThrow("Invalid project selection");
    expect(transport.request).not.toHaveBeenCalled();
  });
  it("still audits damaged retained project assets after that project is excluded", async () => {
    const filesystem = new MemoryArchiveFileSystem();
    const discovery = await new ChatGptInventoryEngine({ transport: fullTransport(), filesystem, workspace, settings: DEFAULT_INVENTORY_SETTINGS }).run();
    await new ChatGptCaptureEngine({ transport: fullTransport(), filesystem, workspace, runId: "all" }).run();
    await saveProjectSelection(filesystem, discovery, ["project-2"]);
    const assets = JSON.parse((await filesystem.readText("projects/project-2/assets.json"))!);
    await filesystem.writeTextAtomic(assets.assets[0].relativePath.replace(/^\.\.\/\.\.\//, ""), "damaged retained project asset");
    const report = await auditArchive({ filesystem, extensionVersion: "test" });
    expect(report.terminalState).toBe("conversations_complete_assets_partial");
    expect(report.findings.some((finding) => finding.code === "ASSET_HASH_MISMATCH")).toBe(true);
  });
});

function fullTransport(overlap = false): ChatGptTransport & { request: ReturnType<typeof vi.fn> } {
  const projectBytes = new TextEncoder().encode("project-level file");
  const handles = new Set<string>();
  const request = vi.fn(async (operation: ChatGptOperationParameters): Promise<ApiSuccessResponse> => {
    let body: JsonValue;
    if (operation.operation === "conversation_page") {
      const all = operation.parameters.archived
        ? [listing("conversation-2"), listing("conversation-4")]
        : [listing("conversation-1"), listing("conversation-2"), listing("conversation-3")];
      body = { items: all.slice(operation.parameters.offset, operation.parameters.offset + operation.parameters.limit), total: all.length, offset: operation.parameters.offset, limit: operation.parameters.limit };
    } else if (operation.operation === "project_page") {
      body = { items: [
        { gizmo: { gizmo: { id: "project-1", display: { name: "One" } }, files: [] } },
        { gizmo: { gizmo: { id: "project-2", display: { name: "Two" } }, files: [{ file_id: "project-file", name: "project.txt", type: "text/plain", size: projectBytes.byteLength }] } },
      ], cursor: null };
    } else if (operation.operation === "project_conversation_page") {
      body = operation.parameters.projectId === "project-1"
        ? { items: [listing("conversation-1"), listing("project-only")], cursor: null }
        : { items: overlap ? [listing("conversation-1"), listing("conversation-2")] : [], cursor: null };
    } else if (operation.operation === "shared_page") {
      body = { items: [{ id: "share-owned", conversation_id: "conversation-1", title: "Owned" }, { id: "share-only", title: "Share only" }], total: 2 };
    } else if (operation.operation === "conversation_batch") {
      body = operation.parameters.conversationIds
        .filter((id) => id !== "conversation-2")
        .map((id) => detailFor(id) as unknown as JsonValue);
    } else if (operation.operation === "conversation_detail") {
      body = detailFor(operation.parameters.conversationId) as unknown as JsonValue;
    } else if (operation.operation === "shared_detail") {
      body = detailFor("shared-provider-detail") as unknown as JsonValue;
    } else if (operation.operation === "account_artifact") {
      body = operation.parameters.kind === "memories" ? { memories: [] } : {};
    } else if (operation.operation === "asset_open") {
      expect(operation.parameters).toMatchObject({ fileId: "project-file", conversationId: null, projectId: "project-2" });
      const handleId = crypto.randomUUID();
      handles.add(handleId);
      body = { handleId, mediaType: "text/plain", expectedBytes: projectBytes.byteLength };
    } else if (operation.operation === "asset_chunk") {
      expect(handles.has(operation.parameters.handleId)).toBe(true);
      const chunk = projectBytes.slice(operation.parameters.offset, operation.parameters.offset + operation.parameters.length);
      body = {
        handleId: operation.parameters.handleId,
        offset: operation.parameters.offset,
        nextOffset: operation.parameters.offset + chunk.byteLength,
        byteLength: chunk.byteLength,
        dataBase64: btoa(String.fromCharCode(...chunk)),
        eof: operation.parameters.offset + chunk.byteLength >= projectBytes.byteLength,
      };
    } else if (operation.operation === "asset_close") {
      body = { handleId: operation.parameters.handleId, closed: handles.delete(operation.parameters.handleId) };
    } else {
      throw new Error(`unexpected ${operation.operation}`);
    }
    return success(body);
  });
  return { request } as ChatGptTransport & { request: ReturnType<typeof vi.fn> };
}

function workspaceTransport(): ChatGptTransport & { request: ReturnType<typeof vi.fn> } {
  const request = vi.fn(async (operation: ChatGptOperationParameters, workspaceId: string | null): Promise<ApiSuccessResponse> => {
    if (operation.operation !== "conversation_page") throw new Error(`unexpected ${operation.operation}`);
    const items = workspaceId === "account-empty" ? [] : [listing("same-id")];
    return success({ items, total: items.length, offset: operation.parameters.offset, limit: operation.parameters.limit });
  });
  return { request } as ChatGptTransport & { request: ReturnType<typeof vi.fn> };
}

function listing(id: string): JsonValue {
  return { id, title: `Synthetic ${id}`, create_time: 1, update_time: 2 };
}

function detailFor(id: string) {
  const detail = conversationDetail({ id, title: `Synthetic ${id}` });
  if (id === "conversation-1") {
    detail.mapping["user-1"]!.children.push("assistant-alt");
    detail.mapping["assistant-alt"] = {
      id: "assistant-alt", parent: "user-1", children: [],
      message: {
        id: "message-assistant-alt", author: { role: "assistant" }, create_time: 3,
        content: { content_type: "text", parts: ["Alternate branch"] }, metadata: {},
      },
    };
  } else if (id === "conversation-2") {
    detail.mapping["assistant-1"]!.message!.content = { content_type: "code", code: "const synthetic = true;", language: "typescript" };
    detail.mapping["assistant-1"]!.message!.metadata = { citations: [{ url: "https://example.test/source", title: "Source" }] };
  } else if (id === "conversation-3") {
    detail.mapping["user-1"]!.message!.content = {
      content_type: "multimodal_text",
      parts: [
        { content_type: "image_asset_pointer", asset_pointer: "data:image/png;base64,iVBORw0KGgo=" },
        { content_type: "audio_asset_pointer", asset_pointer: "data:audio/wav;base64,UklGRg==" },
        { content_type: "future_widget", payload: "synthetic" },
      ],
    };
  } else if (id === "conversation-4") {
    detail.mapping["assistant-1"]!.message!.content = { content_type: "canvas", text: "Synthetic canvas" };
  } else if (id === "project-only") {
    detail.mapping["assistant-1"]!.message!.content = { content_type: "browsing_result", result: "Synthetic browsing result" };
    detail.mapping["assistant-1"]!.message!.metadata = { is_async_task_result_message: true, deep_research_version: "full" };
  }
  return detail;
}

function success(body: JsonValue): ApiSuccessResponse {
  return {
    requestId: "request",
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    ok: true,
    status: 200,
    body,
    responseBytes: JSON.stringify(body).length,
    correlationId: "correlation",
  };
}

async function authoritativeHash(filesystem: MemoryArchiveFileSystem): Promise<string> {
  const paths = (await filesystem.listPaths()).filter((path) => path.startsWith("conversations/") || path.startsWith("assets/") || path.startsWith("source/inventory/"));
  const rows: string[] = [];
  for (const path of paths) rows.push(`${path}\0${await sha256Hex((await filesystem.readBytes(path))!)}`);
  return sha256Hex(rows.sort().join("\n"));
}
