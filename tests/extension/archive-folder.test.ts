import { describe, expect, it, vi } from "vitest";
import { inspectArchiveFolder, workspaceArchiveDirectory } from "../../src/extension/archive-folder";

const fingerprint = "a".repeat(32);
function directory(name: string, files: Record<string, string> = {}, children: Record<string, FileSystemDirectoryHandle> = {}) {
  const getDirectoryHandle = vi.fn(async (child: string, options?: FileSystemGetDirectoryOptions) => {
    if (children[child]) return children[child];
    if (options?.create) return children[child] = directory(child);
    throw new DOMException("Missing directory", "NotFoundError");
  });
  return {
    kind: "directory", name, getDirectoryHandle,
    getFileHandle: vi.fn(async (file: string) => {
      if (files[file] === undefined) throw new DOMException("Missing file", "NotFoundError");
      return { getFile: async () => new File([files[file]!], file) };
    }),
    async *entries() { for (const child of Object.entries(children)) yield child; for (const file of Object.keys(files)) yield [file, { kind: "file", name: file }]; },
  } as unknown as FileSystemDirectoryHandle & { getDirectoryHandle: ReturnType<typeof vi.fn> };
}
const manifest = (id = fingerprint) => JSON.stringify({ schemaVersion: 1, provider: "chatgpt-web", workspaceFingerprint: id, currentIndexHashes: {} });

describe("parent / direct archive directory resolution", () => {
  it("reads a new directory without creating workspace folders", async () => {
    const root = directory("parent");
    expect(await inspectArchiveFolder(root)).toEqual({ directArchive: false, empty: true, archives: [] });
    expect(await workspaceArchiveDirectory(root, fingerprint)).toBeUndefined();
    expect(root.getDirectoryHandle.mock.calls.every(([, options]) => options?.create === false)).toBe(true);
  });

  it("supports direct archive roots without nesting and blocks a different workspace", async () => {
    const root = directory("existing", { "archive.json": manifest() });
    expect((await inspectArchiveFolder(root)).directArchive).toBe(true);
    expect(await workspaceArchiveDirectory(root, fingerprint, true)).toBe(root);
    await expect(workspaceArchiveDirectory(root, "b".repeat(32), true)).rejects.toThrow("different workspace");
    expect(root.getDirectoryHandle.mock.calls.every(([name, options]) => !String(name).startsWith("ChatGPTExport-") && options?.create === false)).toBe(true);
  });

  it("inspects sibling archives and resolves only the selected workspace", async () => {
    const child = directory(`ChatGPTExport-${fingerprint}`, { "archive.json": manifest() });
    const other = directory(`ChatGPTExport-${"b".repeat(32)}`, { "archive.json": manifest("b".repeat(32)) });
    const root = directory("parent", { "unrelated.txt": "keep" }, { [child.name]: child, [other.name]: other });
    const inspection = await inspectArchiveFolder(root);
    expect(inspection).toMatchObject({ directArchive: false, empty: false });
    expect(inspection.archives.map((entry) => entry.status.workspaceFingerprint)).toEqual([fingerprint, "b".repeat(32)]);
    expect(await workspaceArchiveDirectory(root, fingerprint)).toBe(child);
    expect(root.getDirectoryHandle.mock.calls.every(([, options]) => options?.create === false)).toBe(true);
    expect(child.getDirectoryHandle.mock.calls.every(([, options]) => options?.create === false)).toBe(true);
  });

  it("blocks damaged roots and renamed child archives instead of silently nesting/overwriting", async () => {
    const damaged = directory("damaged", { "archive.json": "{bad" });
    await expect(workspaceArchiveDirectory(damaged, fingerprint, true)).rejects.toThrow("unreadable");
    expect(damaged.getDirectoryHandle).not.toHaveBeenCalled();
    const child = directory(`ChatGPTExport-${fingerprint}`, { "archive.json": manifest("b".repeat(32)) });
    const root = directory("parent", {}, { [child.name]: child });
    await expect(workspaceArchiveDirectory(root, fingerprint, true)).rejects.toThrow("identity mismatch");
  });
});
