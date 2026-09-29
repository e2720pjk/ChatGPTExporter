import { describe, expect, it } from "vitest";

import { CaptureStore, type RawCompletionMarker } from "../../src/core/capture-store";
import { MemoryArchiveFileSystem } from "../../src/core/filesystem";
import type { InventoryConversation } from "../../src/core/types";

const conversation: InventoryConversation = {
  logicalKey: `${"a".repeat(32)}/conversation-1`,
  conversationId: "conversation-1",
  title: "Synthetic",
  createTime: 1,
  updateTime: 2,
  memberships: [{ scope: "main" }],
  listingHashes: ["listing-1"],
};

describe("append-preserving capture store", () => {
  it("persists valid journal transitions before allowing completion", async () => {
    const filesystem = new MemoryArchiveFileSystem();
    const timestamps = [0, 1, 2, 3, 4].map((second) => new Date(`2026-08-01T00:00:0${second}.000Z`));
    const store = new CaptureStore(filesystem, "run-1", "a".repeat(32), () => timestamps.shift()!);
    await store.start();
    await store.transition(conversation, "pending", { attempt: 1, correlationId: "pending" });
    await store.transition(conversation, "capturing", { attempt: 1, correlationId: "capture" });
    await store.transition(conversation, "writing", { attempt: 1, correlationId: "write", rawHash: "raw" });
    await store.transition(conversation, "complete", { attempt: 1, correlationId: "complete", completionHash: "marker" });
    const journal = JSON.parse((await filesystem.readText("runs/run-1.json"))!);
    expect(journal.entries.map((entry: { to: string }) => entry.to)).toEqual(["pending", "capturing", "writing", "complete"]);
    await expect(store.transition(conversation, "capturing", { attempt: 2, correlationId: "invalid" })).rejects.toThrow("Invalid capture transition");
  });

  it("deduplicates identical raw revisions by hash and retains changed revisions", async () => {
    const filesystem = new MemoryArchiveFileSystem();
    const store = new CaptureStore(filesystem, "run-1", "a".repeat(32));
    const first = await store.writeRawRevision("conversation-1", "detail", { id: "conversation-1", value: 1 });
    const repeat = await store.writeRawRevision("conversation-1", "detail", { value: 1, id: "conversation-1" });
    const changed = await store.writeRawRevision("conversation-1", "detail", { id: "conversation-1", value: 2 });
    expect(repeat).toEqual(first);
    expect(changed.hash).not.toBe(first.hash);
    expect(filesystem.paths().filter((path) => path.includes("/detail-"))).toHaveLength(2);
  });

  it("stores shared batch revisions once and rejects corrupted content-addressed files", async () => {
    const filesystem = new MemoryArchiveFileSystem();
    const store = new CaptureStore(filesystem, "run-1", "a".repeat(32));
    const batch = [{ id: "conversation-1" }, { id: "conversation-2" }];
    const first = await store.writeRawBatchRevision(batch);
    const repeat = await store.writeRawBatchRevision(batch);

    expect(repeat).toEqual(first);
    expect(first.path).toBe(`source/batches/batch-${first.hash}.json`);
    expect(filesystem.paths().filter((path) => path.startsWith("source/batches/"))).toEqual([first.path]);
    await filesystem.writeTextAtomic(first.path, "corrupted\n");
    await expect(store.writeRawBatchRevision(batch)).rejects.toThrow("Existing raw revision hash mismatch");
  });

  it("accepts legacy batch paths but rejects references outside the archive", async () => {
    const filesystem = new MemoryArchiveFileSystem();
    const store = new CaptureStore(filesystem, "run-1", "a".repeat(32));
    const detail = await store.writeRawRevision("conversation-1", "detail", { id: "conversation-1" });
    const batch = await store.writeRawBatchRevision([{ id: "conversation-1" }]);
    const legacyBatchPath = `conversations/conversation-1/source/batch-${batch.hash}.json`;
    await filesystem.writeTextAtomic(legacyBatchPath, (await filesystem.readText(batch.path))!);
    const marker: RawCompletionMarker = {
      schemaVersion: 1,
      provider: "chatgpt-web",
      logicalKey: conversation.logicalKey,
      conversationId: conversation.conversationId,
      workspaceFingerprint: "a".repeat(32),
      listingHashes: conversation.listingHashes,
      detailHash: detail.hash,
      detailPath: detail.path,
      batchHash: batch.hash,
      batchPath: legacyBatchPath,
      retrievalSource: "batch",
      completedAt: "2026-08-01T00:00:00.000Z",
    };
    await store.writeRawMarker(marker);
    expect(await store.validRawMarker(conversation)).toEqual(marker);

    await store.writeRawMarker({ ...marker, batchPath: "../../outside.json" });
    expect(await store.validRawMarker(conversation)).toBeUndefined();
  });

  it("resumes only from a marker whose identity, listings, and referenced bytes all validate", async () => {
    const filesystem = new MemoryArchiveFileSystem();
    const store = new CaptureStore(filesystem, "run-1", "a".repeat(32));
    const detail = await store.writeRawRevision("conversation-1", "detail", { id: "conversation-1" });
    const marker: RawCompletionMarker = {
      schemaVersion: 1,
      provider: "chatgpt-web",
      logicalKey: conversation.logicalKey,
      conversationId: conversation.conversationId,
      workspaceFingerprint: "a".repeat(32),
      listingHashes: conversation.listingHashes,
      detailHash: detail.hash,
      detailPath: detail.path,
      batchHash: null,
      batchPath: null,
      retrievalSource: "single",
      completedAt: "2026-08-01T00:00:00.000Z",
    };
    await store.writeRawMarker(marker);
    expect(await store.validRawMarker(conversation)).toEqual(marker);
    expect(await store.validRawMarker({ ...conversation, listingHashes: ["changed"] })).toBeUndefined();
    await filesystem.writeTextAtomic(detail.path, "corrupted\n");
    expect(await store.validRawMarker(conversation)).toBeUndefined();
  });
});
