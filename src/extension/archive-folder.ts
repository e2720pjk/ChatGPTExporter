import { readArchiveFolderStatus, type ArchiveFolderStatus } from "../chatgpt/archive-status";
import { DirectoryArchiveFileSystem } from "../core/filesystem";
import { parseJson } from "../core/serialization";

export interface FolderArchiveEntry {
  directoryName: string;
  status: ArchiveFolderStatus;
}

export interface FolderInspection {
  directArchive: boolean;
  empty: boolean;
  archives: FolderArchiveEntry[];
}

/** Supports either an archive root or a parent of isolated workspace archives. Never creates while reading. */
export async function workspaceArchiveDirectory(
  directory: FileSystemDirectoryHandle,
  fingerprint: string,
  create = false,
): Promise<FileSystemDirectoryHandle | undefined> {
  const filesystem = new DirectoryArchiveFileSystem(directory);
  const texts = await Promise.all(["archive.json", "inventory.json"].map((path) => filesystem.readText(path)));
  if (texts.some((text) => text !== undefined)) {
    for (const text of texts.filter((text) => text !== undefined)) {
      const identity = parseJson<{ schemaVersion: number; provider: string; workspaceFingerprint: string }>(text);
      if (identity?.schemaVersion !== 1 || identity.provider !== "chatgpt-web" || identity.workspaceFingerprint !== fingerprint) {
        throw new Error("This folder is an unreadable or different workspace archive. Choose its parent or a matching workspace; no nested archive will be created.");
      }
    }
    return directory;
  }
  if (await filesystem.readText("indexes/conversations.jsonl") !== undefined || await filesystem.readText("reports/validation.json") !== undefined) {
    throw new Error("Archive artifacts exist without a readable workspace identity. Choose another destination; no nested archive will be created.");
  }
  if (!/^[a-f0-9]{32}$/.test(fingerprint)) throw new Error("Invalid workspace fingerprint.");
  try {
    const child = await directory.getDirectoryHandle(`ChatGPTExport-${fingerprint}`, { create });
    // Prevent writing to a renamed or misidentified child archive.
    const childFilesystem = new DirectoryArchiveFileSystem(child);
    for (const path of ["archive.json", "inventory.json"]) {
      const text = await childFilesystem.readText(path);
      if (text === undefined) continue;
      const identity = parseJson<{ schemaVersion: number; provider: string; workspaceFingerprint: string }>(text);
      if (identity?.schemaVersion !== 1 || identity.provider !== "chatgpt-web" || identity.workspaceFingerprint !== fingerprint) {
        throw new Error(`Archive identity mismatch in ${child.name}. Choose another destination.`);
      }
    }
    return child;
  } catch (error) {
    if (!create && error instanceof DOMException && error.name === "NotFoundError") return undefined;
    throw error;
  }
}

export async function inspectArchiveFolder(directory: FileSystemDirectoryHandle): Promise<FolderInspection> {
  const rootStatus = await readArchiveFolderStatus(new DirectoryArchiveFileSystem(directory));
  if (rootStatus.kind !== "new") {
    return { directArchive: true, empty: false, archives: [{ directoryName: directory.name, status: rootStatus }] };
  }
  const result: FolderInspection = { directArchive: false, empty: true, archives: [] };
  const entries = directory as FileSystemDirectoryHandle & { entries(): AsyncIterableIterator<[string, FileSystemHandle]> };
  for await (const [name, handle] of entries.entries()) {
    result.empty = false;
    if (handle.kind !== "directory" || !name.startsWith("ChatGPTExport-")) continue;
    result.archives.push({ directoryName: name, status: await readArchiveFolderStatus(new DirectoryArchiveFileSystem(handle as FileSystemDirectoryHandle)) });
  }
  result.archives.sort((left, right) => left.directoryName.localeCompare(right.directoryName));
  return result;
}
