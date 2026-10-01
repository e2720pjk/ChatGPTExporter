import { ChatGptClient, type DiscoveredWorkspace } from "../chatgpt/client";
import { DirectoryArchiveFileSystem } from "../core/filesystem";
import { DEFAULT_INVENTORY_SETTINGS, runWorkspaceInventories, saveProjectSelection } from "../chatgpt/inventory";
import { currentExportInventory } from "../core/selection";
import type { ConversationInventory } from "../core/types";
import { inspectArchiveFolder, workspaceArchiveDirectory, type FolderInspection } from "./archive-folder";
import { ChatGptCaptureEngine } from "../chatgpt/capture-engine";
import { auditArchive, type ArchiveAuditReport } from "../chatgpt/audit";
import { ControlledTransport } from "../core/request-control";
import { ensureDirectoryPermission, loadDirectoryHandle, saveDirectoryHandle } from "./handle-store";
import { BridgeResponseError, RuntimeApiTransport, type FindTabResult } from "./protocol";

const chooseButton = element<HTMLButtonElement>("choose-directory");
const openButton = element<HTMLButtonElement>("open-chatgpt");
const findButton = element<HTMLButtonElement>("find-chatgpt");
const preflightButton = element<HTMLButtonElement>("preflight-workspace");
const inventoryButton = element<HTMLButtonElement>("run-inventory");
const captureButton = element<HTMLButtonElement>("run-capture");
const confirmInventoryButton = element<HTMLButtonElement>("confirm-inventory");
const revalidateButton = element<HTMLButtonElement>("revalidate");
const pauseButton = element<HTMLButtonElement>("pause-run");
const resumeButton = element<HTMLButtonElement>("resume-run");
const cancelButton = element<HTMLButtonElement>("cancel-run");
const workspaceSelect = element<HTMLSelectElement>("workspace-select");
const archivedScope = element<HTMLInputElement>("scope-archived");
const projectScope = element<HTMLInputElement>("scope-projects");
const sharedScope = element<HTMLInputElement>("scope-shared");
const accountScope = element<HTMLInputElement>("scope-account");
const assetScope = element<HTMLInputElement>("scope-assets");
const requestDelay = element<HTMLInputElement>("request-delay");
const requestConcurrency = element<HTMLInputElement>("request-concurrency");
const batchSize = element<HTMLInputElement>("batch-size");
const inventorySummary = element<HTMLElement>("inventory-summary");
const projectSelection = element<HTMLElement>("project-selection");
const archiveSummary = element<HTMLElement>("archive-summary");
const directoryLabel = element<HTMLElement>("directory-label");
const status = element<HTMLElement>("status");
const log = element<HTMLElement>("log");
const captureProgress = element<HTMLProgressElement>("capture-progress");

let directoryHandle: FileSystemDirectoryHandle | undefined;
let client: ChatGptClient | undefined;
let runtimeTransport: RuntimeApiTransport | undefined;
let workspaces: DiscoveredWorkspace[] = [];
let verifiedWorkspaces: DiscoveredWorkspace[] = [];
let inventoryConfirmed = false;
let inventories = new Map<string, ConversationInventory>();
let folderInspection: FolderInspection | undefined;
let folderReadSequence = 0;
let activeController: ControlledTransport | undefined;

chooseButton.addEventListener("click", () => void chooseDirectory());
openButton.addEventListener("click", () => void chrome.tabs.create({ url: "https://chatgpt.com/" }));
findButton.addEventListener("click", () => void findTabAndWorkspaces());
preflightButton.addEventListener("click", () => void preflightWorkspace());
inventoryButton.addEventListener("click", () => void runInventory());
captureButton.addEventListener("click", () => void runCapture());
confirmInventoryButton.addEventListener("click", () => void confirmInventory());
revalidateButton.addEventListener("click", () => void revalidateArchives());
pauseButton.addEventListener("click", () => activeController?.pause());
resumeButton.addEventListener("click", () => activeController?.resume());
cancelButton.addEventListener("click", () => activeController?.cancel());
[archivedScope, projectScope, sharedScope].forEach((scope) => scope.addEventListener("change", () => {
  inventoryConfirmed = false;
  confirmInventoryButton.disabled = true;
  captureButton.disabled = true;
  revalidateButton.disabled = true;
  inventories.clear();
  renderProjectSelection();
  renderArchiveSummary();
  inventorySummary.textContent = "Scope selection changed. Build and confirm a fresh inventory before capture.";
}));
workspaceSelect.addEventListener("change", () => {
  verifiedWorkspaces = [];
  inventories.clear();
  renderProjectSelection();
  renderArchiveSummary();
  chooseButton.disabled = true;
  inventoryButton.disabled = true;
  captureButton.disabled = true;
  confirmInventoryButton.disabled = true;
  revalidateButton.disabled = true;
  inventoryConfirmed = false;
  preflightButton.disabled = workspaceSelect.selectedOptions.length === 0;
  directoryLabel.textContent = workspaceSelect.selectedOptions.length ? "Verify selected workspaces first" : "Select one or more workspaces first";
});
void restoreDirectory();

async function restoreDirectory(): Promise<void> {
  directoryHandle = await loadDirectoryHandle();
  if (directoryHandle) {
    const granted = await ensureDirectoryPermission(directoryHandle, false);
    directoryLabel.textContent = granted ? `${directoryHandle.name} (permission retained)` : `${directoryHandle.name} (permission required)`;
  }
}

async function chooseDirectory(): Promise<void> {
  if (verifiedWorkspaces.length === 0) {
    setStatus("Verify one or more workspaces before choosing their parent archive directory.", "error");
    return;
  }
  try {
    const selectedHandle = await window.showDirectoryPicker({ id: "chatgpt-exporter-parent", mode: "readwrite" });
    directoryHandle = selectedHandle;
    await saveDirectoryHandle(selectedHandle);
    await enableSelectedDirectory(selectedHandle);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) showError(error);
  }
}

async function enableSelectedDirectory(handle: FileSystemDirectoryHandle): Promise<void> {
  inventories.clear();
  renderProjectSelection();
  directoryLabel.textContent = handle.name;
  inventoryButton.disabled = true;
  captureButton.disabled = true;
  confirmInventoryButton.disabled = true;
  revalidateButton.disabled = true;
  inventoryConfirmed = false;
  await refreshArchiveSummary();
  inventoryButton.disabled = false;
  setStatus(`${verifiedWorkspaces.length} workspace${verifiedWorkspaces.length === 1 ? " is" : "s are"} ready. Review the local archive snapshot, then build inventory.`, "ready");
}

async function findTabAndWorkspaces(): Promise<void> {
  setBusy(findButton, true);
  resetWorkspaceSelection();
  setStatus("Checking the signed-in ChatGPT session and accessible workspaces…", "busy");
  try {
    const tab = await chrome.runtime.sendMessage<{ type: "CHATGPT_EXPORTER_FIND_TAB" }, FindTabResult>({ type: "CHATGPT_EXPORTER_FIND_TAB" });
    if (!tab.ok || tab.tabId === undefined) throw new Error(tab.error ?? "No ChatGPT tab was found.");
    runtimeTransport = new RuntimeApiTransport(tab.tabId);
    client = new ChatGptClient(runtimeTransport);
    workspaces = (await client.discoverWorkspaces()).filter((workspace) => !workspace.deactivated);
    if (workspaces.length === 0) throw new Error("ChatGPT returned no active accessible workspaces.");
    renderWorkspaces(workspaces);
    setStatus(`Found ${workspaces.length} accessible workspace${workspaces.length === 1 ? "" : "s"}. Select one explicitly.`, "ready");
    log.textContent = "Only sanitized workspace labels are shown. Account identifiers will be hashed before any directory or report name is written.";
  } catch (error) {
    showError(error);
  } finally {
    setBusy(findButton, false);
  }
}

async function preflightWorkspace(): Promise<void> {
  const selectedFingerprints = new Set([...workspaceSelect.selectedOptions].map((item) => item.value));
  const selected = workspaces.filter((candidate) => selectedFingerprints.has(candidate.workspaceFingerprint));
  if (!client || selected.length === 0) {
    setStatus("Choose one or more accessible workspaces first.", "error");
    return;
  }
  setBusy(preflightButton, true);
  setStatus("Verifying session, workspace access, and conversation listing…", "busy");
  try {
    const verified: DiscoveredWorkspace[] = [];
    let emptyCount = 0;
    for (const workspace of selected) {
      const result = await client.preflight(workspace);
      verified.push(result.workspace);
      if (result.recognizedEmptyAccount) emptyCount += 1;
    }
    verifiedWorkspaces = verified;
    chooseButton.disabled = false;
    captureButton.disabled = true;
    const retainedDirectory = directoryHandle && await ensureDirectoryPermission(directoryHandle, false);
    if (retainedDirectory) {
      inventoryButton.disabled = true;
      directoryLabel.textContent = `${directoryHandle!.name} (permission retained)`;
      await refreshArchiveSummary();
      inventoryButton.disabled = false;
      setStatus(`Verified ${verified.length} selected workspace${verified.length === 1 ? "" : "s"}${emptyCount ? ` (${emptyCount} empty)` : ""}. The retained archive directory is ready.`, "ready");
    } else {
      inventoryButton.disabled = true;
      directoryLabel.textContent = "No directory selected for this workspace";
      setStatus(`Verified ${verified.length} selected workspace${verified.length === 1 ? "" : "s"}${emptyCount ? ` (${emptyCount} empty)` : ""}. Choose their parent archive directory.`, "ready");
    }
    log.textContent = `Preflight passed for ${verified.length} workspace fingerprint${verified.length === 1 ? "" : "s"}. Each archive will use ChatGPTExport-<fingerprint>; no raw account identifier is written.`;
  } catch (error) {
    verifiedWorkspaces = [];
    chooseButton.disabled = true;
    inventoryButton.disabled = true;
    captureButton.disabled = true;
    if (error instanceof BridgeResponseError && error.code === "AUTHENTICATION_REQUIRED") {
      setStatus("ChatGPT sign-in expired. Sign in or refresh the ChatGPT tab, then find it again.", "error");
    } else if (error instanceof BridgeResponseError && error.code === "RATE_LIMITED") {
      const wait = error.retryAfterMs === undefined ? "the server's cooldown" : `${Math.ceil(error.retryAfterMs / 1_000)} seconds`;
      setStatus(`ChatGPT rate-limited preflight. Wait ${wait}, then verify again.`, "error");
    } else {
      showError(error);
    }
  } finally {
    setBusy(preflightButton, false);
  }
}

function renderWorkspaces(values: DiscoveredWorkspace[]): void {
  workspaceSelect.replaceChildren(option("", "Choose a workspace…"));
  for (const workspace of values) {
    workspaceSelect.append(option(workspace.workspaceFingerprint, `${workspace.label} · ${workspace.kind}`));
  }
  workspaceSelect.disabled = false;
  preflightButton.disabled = true;
}

function resetWorkspaceSelection(): void {
  workspaces = [];
  client = undefined;
  runtimeTransport = undefined;
  verifiedWorkspaces = [];
  workspaceSelect.replaceChildren(option("", "Checking ChatGPT…"));
  workspaceSelect.disabled = true;
  preflightButton.disabled = true;
  chooseButton.disabled = true;
  inventoryButton.disabled = true;
  captureButton.disabled = true;
  confirmInventoryButton.disabled = true;
  revalidateButton.disabled = true;
  inventoryConfirmed = false;
  inventories.clear();
  renderProjectSelection();
  renderArchiveSummary();
  directoryLabel.textContent = "Verify a workspace first";
}

async function runInventory(): Promise<void> {
  if (verifiedWorkspaces.length === 0 || !directoryHandle || !runtimeTransport) {
    setStatus("Verify selected workspaces and choose their parent archive directory first.", "error");
    return;
  }
  if (!await ensureDirectoryPermission(directoryHandle, true)) {
    setStatus("Write permission for the archive directory is required.", "error");
    return;
  }
  setBusy(inventoryButton, true);
  inventoryConfirmed = false;
  confirmInventoryButton.disabled = true;
  captureButton.disabled = true;
  revalidateButton.disabled = true;
  chooseButton.disabled = true;
  workspaceSelect.disabled = true;
  preflightButton.disabled = true;
  setStatus("Building complete inventory; conversation bodies are not being downloaded yet…", "busy");
  try {
    const controlled = createControlledTransport(runtimeTransport);
    activeController = controlled;
    setRunControls(true);
    const targets = await Promise.all(verifiedWorkspaces.map(async (workspace) => ({
      workspace,
      filesystem: new DirectoryArchiveFileSystem((await workspaceArchiveDirectory(directoryHandle!, workspace.workspaceFingerprint, true))!),
    })));
    inventories.clear();
    renderProjectSelection();
    inventories = await runWorkspaceInventories({
      transport: controlled,
      targets,
      settings: {
        ...DEFAULT_INVENTORY_SETTINGS,
        includeArchived: archivedScope.checked,
        includeProjects: projectScope.checked,
        includeShared: sharedScope.checked,
      },
      onProgress: (workspaceFingerprint, progress) => {
        setStatus(`Inventorying ${workspaceFingerprint.slice(0, 8)}… / ${progress.chainId}, page ${progress.pageNumber}; ${progress.uniqueConversations} unique conversations found…`, "busy");
      },
    });
    const conversationCount = [...inventories.values()].reduce((sum, inventory) => sum + inventory.conversations.length, 0);
    setStatus(`Inventory complete: ${conversationCount} workspace-scoped conversations across ${inventories.size} isolated archives.`, "ready");
    renderProjectSelection();
    renderInventorySummary();
    renderArchiveSummary();
    log.textContent = "Every enabled inventory chain terminated normally and its reconciliation report was published. Confirmation is required before body capture.";
    confirmInventoryButton.disabled = false;
    revalidateButton.disabled = false;
  } catch (error) {
    showError(error);
  } finally {
    activeController = undefined;
    setRunControls(false);
    inventoryButton.disabled = false;
    chooseButton.disabled = false;
    workspaceSelect.disabled = false;
    preflightButton.disabled = false;
  }
}

async function runCapture(): Promise<void> {
  if (verifiedWorkspaces.length === 0 || !directoryHandle || !runtimeTransport || !inventoryConfirmed) {
    setStatus("Complete workspace preflight, destination selection, and inventory first.", "error");
    return;
  }
  setBusy(captureButton, true);
  setRunControls(true);
  setStatus("Checking archive permission for the confirmed selection…", "busy");
  inventoryButton.disabled = true;
  chooseButton.disabled = true;
  workspaceSelect.disabled = true;
  preflightButton.disabled = true;
  let captured = 0;
  let rebuilt = 0;
  let skipped = 0;
  let failures = 0;
  let partialAssets = 0;
  const audits: ArchiveAuditReport[] = [];
  try {
    if (!await ensureDirectoryPermission(directoryHandle, true)) {
      setStatus("Write permission for the archive directory is required.", "error");
      return;
    }
    const controlled = createControlledTransport(runtimeTransport);
    activeController = controlled;
    setRunControls(true);
    for (const workspace of verifiedWorkspaces) {
      const archive = (await workspaceArchiveDirectory(directoryHandle, workspace.workspaceFingerprint, true))!;
      const runId = `capture-${Date.now()}-${crypto.randomUUID()}`;
      const result = await new ChatGptCaptureEngine({
        transport: controlled,
        filesystem: new DirectoryArchiveFileSystem(archive),
        workspace,
        runId,
        batchSize: integerValue(batchSize, 1, 10),
        includeAssets: assetScope.checked,
        includeAccountArtifacts: accountScope.checked,
        onProgress: (progress) => {
          if (progress.total > 0) {
            captureProgress.hidden = false;
            captureProgress.max = progress.total;
            captureProgress.value = progress.completed;
          }
          const phase = progress.phase === "writing" ? "downloading assets & writing" : progress.phase === "complete" ? "captured" : progress.phase;
          setStatus(`Capturing ${workspace.workspaceFingerprint.slice(0, 8)}…: ${progress.completed}/${progress.total} conversations (${phase})…`, "busy");
        },
      }).run();
      captured += result.capturedCount;
      rebuilt += result.rebuiltCount;
      skipped += result.skippedCount;
      failures += result.failedCount;
      partialAssets += result.partialAssetCount + result.partialProjectAssetCount;
      audits.push(await auditArchive({ filesystem: new DirectoryArchiveFileSystem(archive), extensionVersion: chrome.runtime.getManifest().version }));
    }
    const terminal = combineAuditState(audits);
    setStatus(`Capture ${terminal}: ${captured} fetched, ${rebuilt} rebuilt, ${skipped} unchanged, ${failures} failed, ${partialAssets} partial asset scopes.`, terminal === "complete" ? "complete" : terminal === "conversations complete / assets partial" ? "partial" : "error");
    log.textContent = "Independent set/hash/graph/asset validation was written to reports/validation.md and reports/validation.json. Run Revalidate only after moving or inspecting the archive; rerun capture to retry incomplete records.";
    revalidateButton.disabled = false;
  } catch (error) {
    showError(error);
  } finally {
    activeController = undefined;
    captureProgress.hidden = true;
    await refreshArchiveSummary().catch(showError);
    setRunControls(false);
    captureButton.disabled = false;
    inventoryButton.disabled = false;
    chooseButton.disabled = false;
    workspaceSelect.disabled = false;
    preflightButton.disabled = false;
  }
}

async function confirmInventory(): Promise<void> {
  if (!directoryHandle || inventories.size === 0) return;
  setRunControls(true);
  [inventoryButton, chooseButton, preflightButton, revalidateButton].forEach((button) => { button.disabled = true; });
  workspaceSelect.disabled = true;
  try {
    for (const workspace of verifiedWorkspaces) {
      const inventory = inventories.get(workspace.workspaceFingerprint)!;
      const archive = (await workspaceArchiveDirectory(directoryHandle, workspace.workspaceFingerprint))!;
      inventories.set(workspace.workspaceFingerprint, await saveProjectSelection(
        new DirectoryArchiveFileSystem(archive), inventory, inventory.projectSelection?.excludedProjectIds ?? [],
      ));
    }
    inventoryConfirmed = true;
    captureButton.disabled = false;
    setStatus("Current selection confirmed. Capture can start/resume; previously saved unselected data will be retained, not refreshed.", "ready");
  } catch (error) {
    inventoryConfirmed = false;
    captureButton.disabled = true;
    showError(error);
  } finally {
    setRunControls(false);
    [inventoryButton, chooseButton, preflightButton, revalidateButton].forEach((button) => { button.disabled = false; });
    workspaceSelect.disabled = false;
  }
}

async function revalidateArchives(): Promise<void> {
  if (verifiedWorkspaces.length === 0 || !directoryHandle) {
    setStatus("Verify the workspaces and restore their archive-directory permission first.", "error");
    return;
  }
  setBusy(revalidateButton, true);
  setRunControls(true);
  [inventoryButton, captureButton, chooseButton, preflightButton].forEach((button) => { button.disabled = true; });
  workspaceSelect.disabled = true;
  try {
    const reports: ArchiveAuditReport[] = [];
    for (const workspace of verifiedWorkspaces) {
      const archive = await workspaceArchiveDirectory(directoryHandle, workspace.workspaceFingerprint);
      if (!archive) throw new Error("No existing archive to revalidate.");
      reports.push(await auditArchive({ filesystem: new DirectoryArchiveFileSystem(archive), extensionVersion: chrome.runtime.getManifest().version }));
    }
    const terminal = combineAuditState(reports);
    const conversations = reports.reduce((sum, report) => sum + report.completeConversationCount, 0);
    const bytes = reports.reduce((sum, report) => sum + report.archiveBytes, 0);
    setStatus(`Revalidation ${terminal}: ${conversations} complete conversations and ${formatBytes(bytes)} audited.`, terminal === "complete" ? "complete" : terminal.includes("partial") ? "partial" : "error");
    log.textContent = "No provider requests were made. Current validation reports and import indexes were rebuilt from local archive bytes.";
  } catch (error) {
    showError(error);
  } finally {
    await refreshArchiveSummary().catch(showError);
    setRunControls(false);
    setBusy(revalidateButton, false);
    [inventoryButton, chooseButton, preflightButton].forEach((button) => { button.disabled = false; });
    captureButton.disabled = !inventoryConfirmed;
    workspaceSelect.disabled = false;
  }
}

function renderProjectSelection(): void {
  projectSelection.replaceChildren();
  if (inventories.size === 0) {
    projectSelection.append(textElement("p", "Build inventory to discover projects. No project conversation details or files are captured at this step."));
    return;
  }
  for (const workspace of verifiedWorkspaces) {
    const inventory = inventories.get(workspace.workspaceFingerprint);
    if (!inventory) continue;
    const group = document.createElement("fieldset");
    group.className = "project-group";
    group.append(textElement("legend", `${workspace.label} · ${workspace.workspaceFingerprint}`));
    const projects = inventory.projects ?? [];
    if (projects.length === 0) group.append(textElement("p", projectScope.checked ? "No projects were discovered." : "Projects scope was not inventoried."));
    for (const project of projects) {
      const row = document.createElement("label");
      row.className = "project-row";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = !inventory.projectSelection?.excludedProjectIds.includes(project.projectId);
      const info = document.createElement("span");
      // ponytail: O(projects × conversations); pre-index memberships if large inventories make rendering slow.
      const memberCount = inventory.conversations.filter((conversation) => conversation.memberships.some((membership) => membership.scope === "project" && membership.projectId === project.projectId)).length;
      info.append(textElement("strong", project.name ?? "Unnamed project"));
      info.append(textElement("code", project.projectId));
      info.append(textElement("span", `${memberCount} discovered conversations · ${project.files.length} discovered files · inventory complete`));
      row.append(input, info);
      group.append(row);
      input.addEventListener("change", () => {
        const current = inventories.get(workspace.workspaceFingerprint)!;
        const excluded = new Set(current.projectSelection?.excludedProjectIds ?? []);
        if (input.checked) excluded.delete(project.projectId);
        else excluded.add(project.projectId);
        current.projectSelection = { excludedProjectIds: [...excluded].sort() };
        inventoryConfirmed = false;
        captureButton.disabled = true;
        revalidateButton.disabled = true;
        confirmInventoryButton.disabled = false;
        renderInventorySummary();
        renderArchiveSummary();
        setStatus("Project selection changed. Confirm the current selection before capture; previously saved files will not be deleted.", "ready");
      });
    }
    projectSelection.append(group);
  }
}

function renderInventorySummary(): void {
  const discovered = [...inventories.values()];
  const selected = discovered.map(currentExportInventory);
  const total = discovered.reduce((sum, inventory) => sum + inventory.conversations.length, 0);
  const count = selected.reduce((sum, inventory) => sum + inventory.conversations.length, 0);
  const projects = selected.reduce((sum, inventory) => sum + (inventory.projects?.length ?? 0), 0);
  const allProjects = discovered.reduce((sum, inventory) => sum + (inventory.projects?.length ?? 0), 0);
  const pages = discovered.reduce((sum, inventory) => sum + inventory.pages.length, 0);
  inventorySummary.textContent = `Provider discovery: ${total} conversations, ${allProjects} projects, ${pages} raw listing pages. This run: ${count} conversations and ${projects} projects selected; ${total - count} conversations excluded by project membership (even if also listed in main/archived/shared).`;
}

async function refreshArchiveSummary(): Promise<void> {
  if (!directoryHandle) return;
  const sequence = ++folderReadSequence;
  const handle = directoryHandle;
  archiveSummary.replaceChildren(textElement("p", "Reading local archive metadata and indexes…"));
  const inspection = await inspectArchiveFolder(handle);
  if (sequence !== folderReadSequence || handle !== directoryHandle) return;
  folderInspection = inspection;
  renderArchiveSummary();
  revalidateButton.disabled = !(verifiedWorkspaces.length > 0 && verifiedWorkspaces.every((workspace) =>
    inspection.archives.some((entry) => entry.status.workspaceFingerprint === workspace.workspaceFingerprint && entry.status.inventory?.complete)));
  try {
    for (const workspace of verifiedWorkspaces) await workspaceArchiveDirectory(handle, workspace.workspaceFingerprint);
  } catch (error) {
    inventoryButton.disabled = true;
    captureButton.disabled = true;
    throw error;
  }
}

function renderArchiveSummary(): void {
  archiveSummary.replaceChildren();
  if (!folderInspection) {
    archiveSummary.append(textElement("p", "Choose an output directory to inspect its existing archives."));
    return;
  }
  archiveSummary.append(textElement("p", "Read-only local snapshot. Counts and completion are recorded artifacts, not a fresh body/asset integrity check. Run Revalidate for a full local audit."));
  if (folderInspection.empty) archiveSummary.append(textElement("p", "This directory is empty. New isolated workspace archives will be created."));
  else if (folderInspection.archives.length === 0) archiveSummary.append(textElement("p", "No ChatGPTExporter archive was found. Other directory contents are not interpreted or removed."));
  for (const entry of folderInspection.archives) {
    const saved = entry.status;
    const workspace = workspaces.find((item) => item.workspaceFingerprint === saved.workspaceFingerprint);
    const card = document.createElement("article");
    card.className = "archive-card";
    card.append(textElement("h3", workspace?.label ?? "Existing workspace archive"));
    card.append(textElement("code", saved.workspaceFingerprint ?? "Workspace identity unavailable"));
    card.append(textElement("p", `Directory: ${entry.directoryName} · ${saved.kind.replaceAll("_", " ")}`));
    if (saved.lastAudit) {
      card.append(textElement("p", `Last recorded audit: ${saved.lastAudit.terminalState.replaceAll("_", " ")} · ${saved.lastAudit.auditedAt}. ${saved.auditMatchesInventory ? "Metadata/index hashes match the recorded selection." : "Freshness unavailable; the current inventory may differ."}`));
    } else card.append(textElement("p", "Completeness: unknown / no reliable validation report."));
    if (saved.conversations) {
      const selectedCount = saved.conversations.filter((row) => row.selectedForCurrentExport).length;
      card.append(textElement("p", `Previously indexed: ${saved.conversations.length} saved conversations · ${selectedCount} in the last indexed selection · ${saved.conversations.length - selectedCount} retained outside it.`));
    } else card.append(textElement("p", "Previously saved conversation counts: unavailable."));
    for (const project of saved.projects) {
      card.append(textElement("p", `${project.name ?? "Unnamed project"} (${project.projectId}): last inventory ${project.discoveredConversationCount} conversations / ${project.discoveredFileCount} files; previously indexed ${project.savedConversationCount ?? "unknown"} conversations / ${project.savedFileCount ?? "unknown"} saved files; last file marker ${project.fileStatus}; previously ${project.selectedForCurrentExport ? "selected" : "excluded"}.`));
    }
    const pending = saved.workspaceFingerprint && inventories.get(saved.workspaceFingerprint);
    if (pending) {
      const selected = currentExportInventory(pending);
      const selectedIds = new Set(selected.conversations.map((conversation) => conversation.conversationId));
      const oldIds = saved.conversations && new Set(saved.conversations.map((row) => row.conversationId));
      const projectIds = new Set(selected.projects?.map((project) => project.projectId));
      const before = new Set(saved.projects.filter((project) => project.selectedForCurrentExport).map((project) => project.projectId));
      card.append(textElement("p", `This run: ${selectedIds.size} selected conversations / ${projectIds.size} selected projects. Project selection difference: ${[...projectIds].filter((id) => !before.has(id)).length} newly included, ${[...before].filter((id) => !projectIds.has(id)).length} no longer included.`));
      if (oldIds) {
        const existing = [...selectedIds].filter((id) => oldIds.has(id)).length;
        const retained = [...oldIds].filter((id) => !selectedIds.has(id)).length;
        card.append(textElement("p", `Capture plan: ${selectedIds.size - existing} not previously indexed, ${existing} previously saved candidates for resume/refresh; hash checks determine skip, rebuild, or download. ${retained} previously saved conversations are outside this run and will be kept, not refreshed.`));
      }
    } else card.append(textElement("p", "No confirmed capture plan for this workspace yet."));
    for (const warning of saved.warnings) card.append(textElement("p", warning, "archive-warning"));
    archiveSummary.append(card);
  }
  for (const workspace of verifiedWorkspaces) {
    const existing = folderInspection.archives.some((entry) => entry.status.workspaceFingerprint === workspace.workspaceFingerprint);
    if (!existing && !folderInspection.directArchive) {
      const inventory = inventories.get(workspace.workspaceFingerprint);
      const selected = inventory && currentExportInventory(inventory);
      archiveSummary.append(textElement("p", `${workspace.label} · ${workspace.workspaceFingerprint}: new archive at ChatGPTExport-${workspace.workspaceFingerprint}.${selected ? ` This run will capture ${selected.conversations.length} selected conversations / ${selected.projects?.length ?? 0} selected projects.` : ""}`));
    }
  }
}

function textElement<K extends keyof HTMLElementTagNameMap>(tag: K, text: string, className = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  return node;
}

function createControlledTransport(transport: RuntimeApiTransport): ControlledTransport {
  return new ControlledTransport(transport, {
    delayMs: integerValue(requestDelay, 0, 60_000),
    maxConcurrency: integerValue(requestConcurrency, 1, 8),
    onState: (state) => {
      if (state === "paused") setStatus("Paused. The active request may finish; no next request will start until Resume.", "paused");
      pauseButton.disabled = state !== "running";
      resumeButton.disabled = state !== "paused";
    },
  });
}

function setRunControls(running: boolean): void {
  pauseButton.disabled = !running || !activeController;
  resumeButton.disabled = true;
  cancelButton.disabled = !running || !activeController;
  requestDelay.disabled = running;
  requestConcurrency.disabled = running;
  batchSize.disabled = running;
  revalidateButton.disabled = running || inventories.size > 0 && !inventoryConfirmed || !(inventories.size > 0 || verifiedWorkspaces.length > 0 && verifiedWorkspaces.every((workspace) =>
    folderInspection?.archives.some((entry) => entry.status.workspaceFingerprint === workspace.workspaceFingerprint && entry.status.inventory?.complete)));
  [archivedScope, projectScope, sharedScope, accountScope, assetScope].forEach((scope) => { scope.disabled = running; });
  projectSelection.querySelectorAll<HTMLInputElement>("input").forEach((input) => { input.disabled = running; });
  confirmInventoryButton.disabled = running || inventories.size === 0 || inventoryConfirmed;
  findButton.disabled = running;
}

function integerValue(input: HTMLInputElement, minimum: number, maximum: number): number {
  const value = Number(input.value);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${input.id} must be ${minimum}-${maximum}.`);
  return value;
}

function combineAuditState(reports: ArchiveAuditReport[]): "complete" | "conversations complete / assets partial" | "incomplete" {
  if (reports.some((report) => report.terminalState === "incomplete")) return "incomplete";
  if (reports.some((report) => report.terminalState === "conversations_complete_assets_partial")) return "conversations complete / assets partial";
  return "complete";
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KiB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MiB`;
  return `${(bytes / 1_073_741_824).toFixed(2)} GiB`;
}

function option(value: string, text: string): HTMLOptionElement {
  const item = document.createElement("option");
  item.value = value;
  item.textContent = text;
  return item;
}

function setBusy(button: HTMLButtonElement, busy: boolean): void {
  button.disabled = busy;
  button.setAttribute("aria-busy", String(busy));
}

function setStatus(message: string, state: string): void {
  status.textContent = message;
  status.dataset.state = state;
}

function showError(error: unknown): void {
  if (error instanceof BridgeResponseError && error.code === "AUTHENTICATION_REQUIRED") {
    setStatus("Authentication required. Sign in or refresh the normal ChatGPT tab, then find and verify it again; completed local work is preserved.", "error");
    return;
  }
  setStatus(error instanceof Error ? error.message : String(error), "error");
}

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing dashboard element: ${id}`);
  return value as T;
}
