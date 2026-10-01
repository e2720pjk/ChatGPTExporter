# Architecture

ChatGPTExporter separates provider access from local archive authority. A normal ChatGPT page owns authentication; the extension dashboard owns the user-selected directory; provider-specific code owns endpoint and shape interpretation; the core owns deterministic storage, hashing, journaling, and validation.

## Runtime boundaries

1. The service worker finds an open `chatgpt.com` tab and routes versioned messages. It cannot construct provider requests.
2. The isolated content relay forwards only the typed protocol and independently rejects unknown fields.
3. The `MAIN`-world page bridge obtains the short-lived session token and applies the selected workspace header inside a private closure. It resolves each operation to one exact read-only endpoint.
4. Signed file URLs remain in page-world asset sessions. Other extension contexts receive only an opaque handle and bounded base64 byte chunks.
5. The dashboard receives sanitized JSON/bytes and writes through the File System Access API. Directory handles are stored in extension-origin IndexedDB; provider credentials are never stored.

The public extension manifest requests no named browser permissions and only the `https://chatgpt.com/*` host permission. Matching-tab discovery is covered by that exact host grant; directory handles use extension-origin IndexedDB and archive bytes use the separately user-granted filesystem. It has no Grok, arbitrary-site, cookie, downloads, storage, tabs, or native-messaging permission.

## Capture sequence

Inventory is authoritative for discovery and the current selected set. The dashboard inventories all enabled project chains before presenting per-project checkboxes; this downloads listing/metadata evidence, not conversation bodies or project files. `inventory.json.projectSelection.excludedProjectIds` is workspace-local and is committed on confirmation. Omission (legacy archives) or an empty list means all discovered projects. Any excluded project membership wins over main, archived, shared, or another included project membership. Capture and audit use the same selected projection; unselected detail, share-detail, and project file requests are not scheduled. Changing inventory scopes requires fresh discovery and confirmation. Membership is based on the provider listing chains actually inventoried, not guessed fields or conversation bodies.

Main and archived history use independent offset chains; the project index and every project conversation list use cursor chains; shared history is independently enumerated. Raw response pages are written before their IDs enter the union. Repeated pages/cursors, premature empty pages, byte/page limits, malformed envelopes, and inconclusive termination fail closed.

Conversation capture reconciles batches of at most ten IDs. Missing, duplicate, malformed, or suspicious graphs fall back to individual detail retrieval; share-only records use the share adapter. Raw listing, batch, and detail revisions are content-addressed before a raw completion marker is written. Each batch response is stored once under `source/batches/` and referenced by every conversation captured from that response; legacy per-conversation batch paths remain readable.

Normalization retains every node/message and provider extension. Deterministic normalized JSON, selected-first branch-aware Markdown, assets, and metadata are written before the final completion marker. A rerun verifies hashes before skipping; damaged derived files rebuild from valid raw bytes without a detail request.

## Inventory reconciliation and history

`reports/reconciliation.json` is the only reconciliation report. Inventory publication and project-selection confirmation regenerate it from the complete current inventory, so a missing, malformed, or stale report is rebuilt without provider requests. Report write failures are surfaced, not silently skipped; confirmation can be retried against the same discovery if inventory was already committed. It is a derived summary, not a selection authority.

- `inventoryHash` is `hashJson()` of the entire current inventory, including selection. This semantic JSON hash is different from the manifest’s SHA-256 of the inventory file bytes.
- Legacy `expectedConversationCount` and `conversationCountsByScope` remain full discovery totals, regardless of exclusions. Chain/page evidence, response-byte totals, and absent-retained counts also describe discovery.
- `selectedConversationCount` and `selectedProjectCount` describe the current selected projection. An omitted project selection means all discovered projects, including for legacy inventories.

Before either discovery or confirmation replaces `inventory.json`, its complete previous document is saved through the same canonical `prettyJson()`/SHA-256 writer at `source/inventory/snapshots/inventory-<hash>.json`. Existing matching snapshots are not rewritten. Snapshots may contain discovery and selection together; they do not have separate discovery-only or selection-only schemas. Current capture/resume, derived rebuild, and audit set calculations use current inventory and raw/completion artifacts, not snapshots.

Earlier `indexes/inventory-snapshots/` files are left untouched, without automatic migration or deletion; they have no current semantic consumer. An existing `indexes/reconciliation.json` is also ignored and left untouched. New confirmation creates neither index artifact. Historical snapshots are evidence, not regenerable indexes or a competing current-selection authority.

## Asset model

Message and project descriptors become logical asset records. Remote files stream in chunks to a staging path while an incremental SHA-256 is computed, then publish once under `assets/<sha256>.<extension>`. Multiple logical references may point to one physical file. Inline binaries and Canvas text use the same content-addressed store.

Per-conversation and per-project asset indexes retain provider ID, source message where applicable, safe/original name, media type, size, hash, adapter, local path, redacted raw descriptor, and explicit failure. Signed query strings never enter derived records, logs, reports, or public bridge responses.

## Independent audit

The audit compares the current inventory, completion-marker, and normalized sets; verifies every marker/file hash; traces normalized nodes and messages to raw graph IDs; hashes downloaded assets; rejects zero-byte/temporary files; and emits byte totals and stable set/index hashes. It writes:

- `reports/validation.json` and `reports/validation.md`;
- `indexes/conversations.jsonl` and `indexes/assets.jsonl`;
- `archive.json`, containing schema/version/scope/run/index identities without a raw workspace ID.

`indexes/conversations.jsonl` explicitly identifies the current selected archive: consume rows with `selectedForCurrentExport: true`. Each row includes workspace identity and authoritative inventory memberships. Previously saved excluded conversations remain indexed with `selectedForCurrentExport: false` and `excludedByProjectSelection: true`; saved conversations absent from discovery also have `absentFromCurrentInventory: true`. `indexes/assets.jsonl` contains only current selected references. Retained normalized/raw files, project files, and CAS blobs are not deleted or refreshed by deselection. Shared raw batches may contain historical unselected records: they are append-preserving evidence, not a competing selection index. Consumers must not enumerate all archive files as if every file were selected.

Audit set hashes/counts use the selected conversation/project set, while integrity checks still cover retained conversation/project data. The manifest mirrors project selection and binds `inventory.json`, conversation/asset indexes, and `reports/validation.json` by hashes; inventory remains the selection authority. When inventory/selection changes, the previous manifest/audit is stale until capture/resume or revalidation republishes it. A changed normalized membership requires a rebuild from valid raw even if listing hashes are unchanged.

Legacy inventories without project selection include all discovered projects. Legacy conversation indexes without explicit selection flags use `absentFromCurrentInventory` to identify retained rows; a new audit emits explicit flags. Legacy raw batch paths remain readable.

## Destination status (read-only)

The chosen destination may be an existing workspace archive root or a parent of isolated `ChatGPTExport-<fingerprint>` directories. Conflicting, unreadable, or renamed archive identities block capture rather than nesting/overwriting another workspace. Selecting a directory reads existing manifest, inventory, conversation index, validation report, and project asset completion/index metadata only; it creates no directories or persistent status cache and never reads conversation bodies or hashes asset blobs. The dashboard displays recorded audit freshness, saved versus selected counts, and pending capture candidates separately. Counts/status that lack reliable artifacts are unavailable. A matching recorded audit is not a fresh physical integrity check; Revalidate performs that check without provider requests.

## Archive layout

```text
ChatGPTExport-<workspace-fingerprint>/
  archive.json
  inventory.json
  source/inventory/
  source/account/
  source/batches/batch-<sha256>.json
  conversations/<conversation-id>/
    source/
    raw-complete.json
    conversation.json
    conversation.md
    metadata.json
    assets.json
    complete.json
  projects/<project-id>/
  assets/<sha256>.<extension>
  indexes/
  reports/
  runs/
```

`source/` and content-addressed `assets/` are authoritative evidence. Normalized views, indexes, reports, and manifests are reproducible projections.
