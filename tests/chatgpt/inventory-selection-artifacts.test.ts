import { describe, expect, it, vi } from "vitest";
import { ChatGptInventoryEngine, DEFAULT_INVENTORY_SETTINGS, saveProjectSelection } from "../../src/chatgpt/inventory";
import type { ChatGptTransport, DiscoveredWorkspace } from "../../src/chatgpt/client";
import type { ChatGptOperationParameters } from "../../src/chatgpt/endpoints";
import { MemoryArchiveFileSystem } from "../../src/core/filesystem";
import { hashJson, sha256Hex } from "../../src/core/hash";
import { prettyJson, toJsonValue } from "../../src/core/serialization";
import type { JsonValue } from "../../src/core/types";
import type { ApiSuccessResponse } from "../../src/extension/protocol";

const workspace: DiscoveredWorkspace = {
  accountId: "synthetic-account", workspaceFingerprint: "a".repeat(32),
  label: "Synthetic", kind: "personal", deactivated: false,
};
const listing = (id: string) => ({ id, title: id, create_time: 1, update_time: 2 });

async function fixture() {
  const filesystem = new MemoryArchiveFileSystem();
  const request = vi.fn(async (operation: ChatGptOperationParameters): Promise<ApiSuccessResponse> => {
    let body: JsonValue;
    if (operation.operation === "conversation_page") {
      const items = operation.parameters.archived ? [listing("c-2")] : [listing("c-1"), listing("c-2"), listing("c-3")];
      body = { items, total: items.length, offset: operation.parameters.offset, limit: operation.parameters.limit };
    } else if (operation.operation === "project_page") {
      body = { items: ["project-A", "project-B"].map((id) => ({ gizmo: { gizmo: { id, display: { name: id } }, files: [] } })), cursor: null };
    } else if (operation.operation === "project_conversation_page") {
      body = { items: [listing(operation.parameters.projectId === "project-A" ? "c-1" : "c-3")], cursor: null };
    } else if (operation.operation === "shared_page") {
      body = { items: [{ id: "share-owned", conversation_id: "c-1", title: "Owned" }, { id: "share-only", title: "Only" }], total: 2 };
    } else throw new Error(`Unexpected provider request: ${operation.operation}`);
    return {
      requestId: "synthetic", protocolVersion: 1, ok: true, status: 200, body,
      responseBytes: new TextEncoder().encode(JSON.stringify(body)).byteLength, correlationId: "synthetic",
    };
  });
  const transport: ChatGptTransport = { request };
  const options = { filesystem, transport, workspace, settings: DEFAULT_INVENTORY_SETTINGS, now: () => new Date("2026-01-01T00:00:00Z") };
  const inventory = await new ChatGptInventoryEngine(options).run();
  return { filesystem, request, inventory, options };
}

async function readReport(filesystem: MemoryArchiveFileSystem): Promise<Record<string, unknown>> {
  return JSON.parse((await filesystem.readText("reports/reconciliation.json"))!);
}

const scopeCounts = { main: 3, archived: 1, project: 2, shared: 2 };

describe("inventory selection artifact contract", () => {
  it("publishes discovery totals and explicit default-all selected counts in the canonical report", async () => {
    const { filesystem, inventory } = await fixture();
    expect(await readReport(filesystem)).toMatchObject({
      workspaceFingerprint: workspace.workspaceFingerprint,
      inventoryHash: await hashJson(toJsonValue(inventory)),
      expectedConversationCount: 4, selectedConversationCount: 4, selectedProjectCount: 2,
      conversationCountsByScope: scopeCounts, allChainsComplete: true,
      pageEvidenceCount: inventory.pages.length,
      aggregateResponseBytes: inventory.pages.reduce((sum, page) => sum + page.responseBytes, 0),
    });
    expect(await filesystem.exists("indexes/reconciliation.json")).toBe(false);
  });

  it("updates current hash/selected counts while keeping discovery counts, chains and page evidence unchanged", async () => {
    const { filesystem, inventory, request } = await fixture();
    const discoveryReport = await readReport(filesystem);
    const requests = request.mock.calls.length;
    const selected = await saveProjectSelection(filesystem, inventory, ["project-A"]);
    const current = JSON.parse((await filesystem.readText("inventory.json"))!);
    expect(current).toEqual(selected);
    expect(await readReport(filesystem)).toEqual({
      ...discoveryReport, inventoryHash: await hashJson(toJsonValue(current)),
      selectedConversationCount: 3, selectedProjectCount: 1,
    });
    expect(request).toHaveBeenCalledTimes(requests);
    expect(await filesystem.exists("indexes/reconciliation.json")).toBe(false);
    expect(await filesystem.listPaths("indexes/inventory-snapshots")).toEqual([]);

    const restored = await saveProjectSelection(filesystem, selected, []);
    expect(await readReport(filesystem)).toEqual({
      ...discoveryReport, inventoryHash: await hashJson(toJsonValue(restored)),
    });
    // Even explicit default-all confirmation changes the inventory document hash.
    expect((await readReport(filesystem)).inventoryHash).not.toBe(discoveryReport.inventoryHash);
  });

  it.each([
    ["missing", undefined],
    ["malformed JSON", "{broken"],
    ["null", "null"],
    ["stale/foreign fields", JSON.stringify({ schemaVersion: 1, workspaceFingerprint: "b".repeat(32), inventoryHash: "stale", expectedConversationCount: 999, selectedConversationCount: 999, extra: "stale" })],
  ])("rebuilds a %s report from inventory on confirmation without provider requests", async (_kind, contents) => {
    const { filesystem, inventory, request } = await fixture();
    const discoveryReport = await readReport(filesystem);
    if (contents === undefined) await filesystem.remove("reports/reconciliation.json");
    else await filesystem.writeTextAtomic("reports/reconciliation.json", contents);
    const requests = request.mock.calls.length;
    const selected = await saveProjectSelection(filesystem, inventory, ["project-A"]);
    expect(await readReport(filesystem)).toEqual({
      ...discoveryReport, inventoryHash: await hashJson(toJsonValue(selected)),
      selectedConversationCount: 3, selectedProjectCount: 1,
    });
    expect(request).toHaveBeenCalledTimes(requests);
    expect(await filesystem.exists("indexes/reconciliation.json")).toBe(false);
  });

  it("shares canonical source snapshots and deduplication across confirmation/inventory rebuild, preserving legacy index artifacts", async () => {
    const { filesystem, inventory, options, request } = await fixture();
    const historicalText = prettyJson(inventory);
    const historicalPath = `source/inventory/snapshots/inventory-${await sha256Hex(historicalText)}.json`;
    const rawText = JSON.stringify(inventory);
    await filesystem.writeTextAtomic("inventory.json", rawText);
    const legacyPath = `indexes/inventory-snapshots/${await sha256Hex(rawText)}.json`;
    await filesystem.writeTextAtomic(legacyPath, rawText);
    const legacyReport = "{\"historical\":true}";
    await filesystem.writeTextAtomic("indexes/reconciliation.json", legacyReport);
    const write = vi.spyOn(filesystem, "writeTextAtomic");
    const remove = vi.spyOn(filesystem, "remove");
    const requests = request.mock.calls.length;

    // UI selection is pending in memory; preserve the on-disk inventory, not the pending choice.
    inventory.projectSelection = { excludedProjectIds: ["project-A"] };
    const selected = await saveProjectSelection(filesystem, inventory, ["project-A"]);
    expect(await filesystem.readText(historicalPath)).toBe(historicalText);
    expect(JSON.parse((await filesystem.readText(historicalPath))!).projectSelection).toBeUndefined();
    expect(write.mock.calls.filter(([path]) => path === historicalPath)).toHaveLength(1);

    const selectedText = prettyJson(selected);
    const selectedPath = `source/inventory/snapshots/inventory-${await sha256Hex(selectedText)}.json`;
    await saveProjectSelection(filesystem, selected, ["project-A"]);
    await saveProjectSelection(filesystem, selected, ["project-A"]);
    expect(request).toHaveBeenCalledTimes(requests);
    expect(write.mock.calls.filter(([path]) => path === selectedPath)).toHaveLength(1);
    const rediscovered = await new ChatGptInventoryEngine(options).run();
    expect(write.mock.calls.filter(([path]) => path === selectedPath)).toHaveLength(1);
    expect(await filesystem.readText(selectedPath)).toBe(selectedText);
    expect(await filesystem.listPaths("source/inventory/snapshots")).toEqual([historicalPath, selectedPath].sort());
    expect(await readReport(filesystem)).toMatchObject({
      inventoryHash: await hashJson(toJsonValue(rediscovered)), selectedConversationCount: 4, selectedProjectCount: 2,
    });
    expect(await filesystem.listPaths("indexes/inventory-snapshots")).toEqual([legacyPath]);
    expect(await filesystem.readText(legacyPath)).toBe(rawText);
    expect(await filesystem.readText("indexes/reconciliation.json")).toBe(legacyReport);
    expect(write.mock.calls.some(([path]) => path.startsWith("indexes/"))).toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });

  it("surfaces report publication failures instead of silently confirming; retry republishes the correct report", async () => {
    const { filesystem, inventory } = await fixture();
    const discoveryReport = await filesystem.readText("reports/reconciliation.json");
    const write = filesystem.writeTextAtomic.bind(filesystem);
    const spy = vi.spyOn(filesystem, "writeTextAtomic").mockImplementation(async (path, content) => {
      if (path === "reports/reconciliation.json") throw new Error("Report write failed");
      await write(path, content);
    });
    await expect(saveProjectSelection(filesystem, inventory, ["project-A"])).rejects.toThrow("Report write failed");
    expect(await filesystem.readText("reports/reconciliation.json")).toBe(discoveryReport);
    spy.mockRestore();
    const retried = await saveProjectSelection(filesystem, inventory, ["project-A"]);
    expect(await readReport(filesystem)).toMatchObject({
      inventoryHash: await hashJson(toJsonValue(retried)), selectedConversationCount: 3, selectedProjectCount: 1,
    });
  });
});
