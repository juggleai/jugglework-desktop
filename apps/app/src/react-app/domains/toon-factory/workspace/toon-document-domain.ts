import type { ToonAssetDescriptor, ToonDocumentDescriptor, ToonDocumentFolderDescriptor } from "@jugglework/types/toon-workspace";

export const TOON_DOCUMENT_EDITABLE_MAX_CHARS = 2_000_000;
const BLOCKED_TREE_SEGMENT = /^(?:generated|node_modules|\.git|\.toon-history|\.toon-journal|\.toon-trash|\.toon-backups|secrets)$/i;
const BLOCKED_TREE_FILENAME = /^(?:\.env|id_rsa|id_ed25519|credentials?)(?:\.|$)/i;

export type ToonDocumentPendingSave = {
  operationId: string;
  content: string;
  revision: string;
  origin: "autosave" | "human-ui";
  attempts: number;
};

export type ToonDocumentSaveState = {
  draft: string;
  saved: string;
  revision: string;
  pendingSave?: ToonDocumentPendingSave;
};

export type ToonDocumentTreeEntry = {
  id: string;
  kind: "folder" | "document" | "asset";
  title: string;
  path: string;
  depth: number;
  state: "active" | "trashed" | "tombstone";
  document?: ToonDocumentDescriptor;
  asset?: ToonAssetDescriptor;
};

function safeTreePath(path: string, root: "documents" | "assets"): boolean {
  const parts = path.split("/");
  return parts[0] === root && !parts.some((part) => BLOCKED_TREE_SEGMENT.test(part) || BLOCKED_TREE_FILENAME.test(part));
}

export function buildToonDocumentTree(documents: ToonDocumentDescriptor[], folders: ToonDocumentFolderDescriptor[], assets: ToonAssetDescriptor[], expanded: ReadonlySet<string>): ToonDocumentTreeEntry[] {
  const result: ToonDocumentTreeEntry[] = [];
  const visibleDocuments = documents.filter((item) => safeTreePath(item.path, "documents"));
  const visibleFolders = folders.filter((item) => safeTreePath(item.path, "documents"));
  const visibleAssets = assets.filter((item) => item.origin !== "generated" && safeTreePath(item.path, "assets"));
  const knownFolders = new Map(visibleFolders.map((folder) => [folder.path, folder]));
  for (const path of visibleDocuments.map((item) => item.path)) {
    const parts = path.split("/").slice(1, -1);
    let current = "documents";
    for (const part of parts) {
      current += `/${part}`;
      if (!knownFolders.has(current)) knownFolders.set(current, { id: `implicit:${current}`, title: part, path: current, state: "active" });
    }
  }
  const children = (parent: string) => {
    const depth = parent.split("/").length - 1;
    for (const folder of [...knownFolders.values()].filter((item) => item.path.slice(0, item.path.lastIndexOf("/")) === parent).sort((a, b) => a.title.localeCompare(b.title))) {
      result.push({ id: folder.id, kind: "folder", title: folder.title, path: folder.path, depth, state: folder.state });
      if (expanded.has(folder.id)) children(folder.path);
    }
    for (const document of visibleDocuments.filter((item) => item.path.slice(0, item.path.lastIndexOf("/")) === parent).sort((a, b) => a.title.localeCompare(b.title))) result.push({ id: document.id, kind: "document", title: document.title, path: document.path, depth, state: document.state, document });
    if (parent === "documents") for (const asset of visibleAssets.filter((item) => item.state !== "tombstone").sort((a, b) => a.title.localeCompare(b.title))) result.push({ id: asset.id, kind: "asset", title: asset.title, path: asset.path, depth, state: asset.state, asset });
  };
  children("documents");
  return result;
}

export function documentOffsetForLine(content: string, line: number, column: number): number {
  const lines = content.split(/\r?\n/);
  let offset = 0;
  for (let index = 0; index < Math.max(0, line - 1) && index < lines.length; index += 1) offset += lines[index]!.length + 1;
  return Math.min(content.length, offset + column);
}

export function editableToonDocument(document: ToonDocumentDescriptor, contentLength = 0): boolean {
  return document.state === "active" && (document.kind === "markdown" || document.kind === "text") && contentLength <= TOON_DOCUMENT_EDITABLE_MAX_CHARS;
}

export function prepareToonDocumentSave(state: ToonDocumentSaveState, operationId: string, origin: ToonDocumentPendingSave["origin"] = "autosave"): ToonDocumentPendingSave | null {
  if (state.draft === state.saved) return null;
  state.pendingSave ??= { operationId, content: state.draft, revision: state.revision, origin, attempts: 0 };
  return state.pendingSave;
}

export function completeToonDocumentSave(state: ToonDocumentSaveState, pending: ToonDocumentPendingSave, revision: string): boolean {
  if (state.pendingSave?.operationId !== pending.operationId) return state.draft !== state.saved;
  state.saved = pending.content;
  state.revision = revision;
  state.pendingSave = undefined;
  return state.draft !== state.saved;
}

export function clearToonDocumentPendingSave(state: ToonDocumentSaveState, pending: ToonDocumentPendingSave): void {
  if (state.pendingSave?.operationId === pending.operationId) state.pendingSave = undefined;
}

export async function flushAllDirtyTabs<T extends ToonDocumentSaveState>(tabs: Iterable<T>, save: (tab: T) => Promise<boolean>): Promise<boolean> {
  for (const tab of tabs) {
    if (tab.draft !== tab.saved && !await save(tab)) return false;
  }
  return true;
}

export function toonWorkspaceRetentionKey(endpoint: string, workspaceId: string, projectId: string): string {
  return `${endpoint.trim().replace(/\/+$/, "")}\u0000${workspaceId}\u0000${projectId}`;
}
