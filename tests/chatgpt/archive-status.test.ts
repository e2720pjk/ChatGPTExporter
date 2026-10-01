import { describe, expect, it, vi } from "vitest";
import { auditArchive } from "../../src/chatgpt/audit";
import { readArchiveFolderStatus } from "../../src/chatgpt/archive-status";
import { MemoryArchiveFileSystem } from "../../src/core/filesystem";
import { sha256Hex } from "../../src/core/hash";
import { prettyJson } from "../../src/core/serialization";
import type { ConversationInventory } from "../../src/core/types";

const inventory: ConversationInventory = {
  schemaVersion: 1, provider: "chatgpt-web", workspaceFingerprint: "a".repeat(32),
  generatedAt: "2026-01-01T00:00:00Z", complete: true, chains: [], pages: [], projects: [], conversations: [],
};

async function completeArchive() {
  const filesystem = new MemoryArchiveFileSystem();
  await filesystem.writeTextAtomic("inventory.json", prettyJson(inventory));
  await auditArchive({ filesystem, extensionVersion: "test" });
  return filesystem;
}

describe("read-only archive folder status", () => {
  it("distinguishes no archive, inventory-only and a recorded complete archive", async () => {
    const filesystem = new MemoryArchiveFileSystem();
    expect(await readArchiveFolderStatus(filesystem)).toMatchObject({ kind: "new", auditMatchesInventory: false });
    await filesystem.writeTextAtomic("inventory.json", prettyJson(inventory));
    expect(await readArchiveFolderStatus(filesystem)).toMatchObject({ kind: "inventory_only", auditMatchesInventory: false });
    const complete = await completeArchive();
    expect(await readArchiveFolderStatus(complete)).toMatchObject({ kind: "archive", auditMatchesInventory: true, conversations: [], lastAudit: { terminalState: "complete", completeConversationCount: 0 } });
  });

  it("never writes, enumerates paths, scans bodies, or hashes asset bytes", async () => {
    const filesystem = await completeArchive();
    const read = vi.spyOn(filesystem, "readText");
    vi.spyOn(filesystem, "listPaths").mockRejectedValue(new Error("No recursive scan"));
    vi.spyOn(filesystem, "writeTextAtomic").mockRejectedValue(new Error("No writes"));
    vi.spyOn(filesystem, "readByteChunks").mockImplementation(() => { throw new Error("No blob reads"); });
    vi.spyOn(filesystem, "remove").mockRejectedValue(new Error("No deletion"));
    expect((await readArchiveFolderStatus(filesystem)).auditMatchesInventory).toBe(true);
    expect(read.mock.calls.map(([path]) => path).sort()).toEqual(["archive.json", "inventory.json", "indexes/conversations.jsonl", "reports/validation.json"].sort());
    expect(filesystem.listPaths).not.toHaveBeenCalled();
    expect(filesystem.writeTextAtomic).not.toHaveBeenCalled();
    expect(filesystem.remove).not.toHaveBeenCalled();
  });

  it("does not claim fresh completeness when inventory, indexes or validation hashes change", async () => {
    for (const path of ["inventory.json", "indexes/conversations.jsonl", "reports/validation.json"]) {
      const filesystem = await completeArchive();
      const previous = (await filesystem.readText(path))!;
      await filesystem.writeTextAtomic(path, previous + " ");
      expect((await readArchiveFolderStatus(filesystem)).auditMatchesInventory).toBe(false);
    }
    const filesystem = await completeArchive();
    await filesystem.writeTextAtomic("indexes/conversations.jsonl", "{corrupt");
    const result = await readArchiveFolderStatus(filesystem);
    expect(result.conversations).toBeUndefined();
    expect(result.warnings.join(" ")).toContain("mismatched");
  });

  it("reads legacy hashed indexes without pretending legacy audit freshness is known", async () => {
    const filesystem = await completeArchive();
    const manifest = JSON.parse((await filesystem.readText("archive.json"))!);
    const index = [{ logicalKey: `${inventory.workspaceFingerprint}/saved`, conversationId: "saved" }, { logicalKey: `${inventory.workspaceFingerprint}/retained`, conversationId: "retained", absentFromCurrentInventory: true }].map((row) => JSON.stringify(row)).join("\n") + "\n";
    delete manifest.currentIndexHashes.inventory;
    delete manifest.currentIndexHashes.validation;
    manifest.currentIndexHashes.conversations = await sha256Hex(index);
    await filesystem.writeTextAtomic("archive.json", prettyJson(manifest));
    await filesystem.writeTextAtomic("indexes/conversations.jsonl", index);
    expect(await readArchiveFolderStatus(filesystem)).toMatchObject({ kind: "archive", auditMatchesInventory: false, conversations: [
      { conversationId: "saved", selectedForCurrentExport: true }, { conversationId: "retained", selectedForCurrentExport: false },
    ] });
  });

  it("reports invalid artifacts and workspace mismatches as unavailable, never as a new/empty archive", async () => {
    const damaged = new MemoryArchiveFileSystem();
    await damaged.writeTextAtomic("archive.json", "{bad");
    expect((await readArchiveFolderStatus(damaged)).kind).toBe("unavailable");
    const mismatch = await completeArchive();
    await mismatch.writeTextAtomic("inventory.json", prettyJson({ ...inventory, workspaceFingerprint: "b".repeat(32) }));
    expect(await readArchiveFolderStatus(mismatch)).toMatchObject({ kind: "unavailable", auditMatchesInventory: false });
    const failedRead = new MemoryArchiveFileSystem();
    vi.spyOn(failedRead, "readText").mockRejectedValue(new Error("Permission unavailable"));
    expect((await readArchiveFolderStatus(failedRead)).warnings).toContain("Permission unavailable");
  });
});
