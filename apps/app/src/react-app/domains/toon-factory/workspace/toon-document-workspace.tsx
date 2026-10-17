/** @jsxImportSource react */
import { lazy, Suspense, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArchiveRestore, ChevronDown, ChevronRight, Copy, File, FilePlus2, Folder, FolderPlus, History, Image, LoaderCircle, MoreHorizontal, Music, Pin, Search, Trash2, Video, X } from "lucide-react";
import type { JuggleWorkServerClient, JuggleWorkServerError } from "@/app/lib/jugglework-server";
import type { ToonAssetDescriptor, ToonDocumentDescriptor, ToonDocumentRevision, ToonDocumentSearchResponse, ToonWorkspaceCatalogsReadResponse, ToonWorkspaceClientCommand } from "@jugglework/types/toon-workspace";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { buildToonDocumentTree, clearToonDocumentPendingSave, completeToonDocumentSave, documentOffsetForLine, editableToonDocument, flushAllDirtyTabs, prepareToonDocumentSave, type ToonDocumentPendingSave } from "./toon-document-domain";
import type { ToonDocumentEditorView } from "./toon-document-editor";
import { clearToonRecoveryDraft, readToonRecoveryDraft, writeToonRecoveryDraft } from "../toon-factory-state";

const ToonDocumentEditor = lazy(() => import("./toon-document-editor"));

type Client = Pick<JuggleWorkServerClient, "queryToonWorkspace" | "executeToonWorkspaceCommand" | "searchToonDocuments" | "listToonDocumentRevisions" | "restoreToonDocumentRevision" | "downloadToonProjectAsset">;
export type ToonDocumentTab = {
  id: string;
  kind: "document" | "asset";
  title: string;
  preview: boolean;
  document?: ToonDocumentDescriptor;
  asset?: ToonAssetDescriptor;
  draft: string;
  saved: string;
  revision: string;
  view: ToonDocumentEditorView;
  conflict: boolean;
  pendingSave?: ToonDocumentPendingSave;
  saving?: boolean;
  compare?: string;
  reveal?: { from: number; to: number } | null;
};
export type ToonDocumentRetainedState = {
  expanded: Set<string>;
  selectedId: string | null;
  tabs: Map<string, ToonDocumentTab>;
  order: string[];
  activeId: string | null;
  recentlyClosed: string[];
  sidebarWidth: number;
  flushAllDirtyTabs?: () => Promise<boolean>;
};

export function createToonDocumentRetainedState(): ToonDocumentRetainedState {
  return { expanded: new Set(), selectedId: null, tabs: new Map(), order: [], activeId: null, recentlyClosed: [], sidebarWidth: 240 };
}

function id(prefix: string): string { return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`; }
function conflict(error: unknown): boolean { return Boolean(error && typeof error === "object" && "code" in error && (error as JuggleWorkServerError).code === "toon_factory_revision_conflict"); }
function fileName(path: string): string { return path.slice(path.lastIndexOf("/") + 1); }
function extension(title: string, kind: ToonDocumentDescriptor["kind"]): string { return title.includes(".") ? title : `${title}.${kind === "markdown" ? "md" : kind === "json" ? "json" : "txt"}`; }

export function ToonDocumentWorkspace(props: { client: Client; workspaceId: string; projectId: string; visible: boolean; readOnly?: boolean; catalogs: ToonWorkspaceCatalogsReadResponse; retained: ToonDocumentRetainedState; onCatalogsChange: () => Promise<ToonWorkspaceCatalogsReadResponse> }) {
  const state = props.retained;
  const [, render] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchMode, setSearchMode] = useState<"filename" | "content" | "all">("all");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ToonDocumentSearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [history, setHistory] = useState<ToonDocumentRevision[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [closingTabId, setClosingTabId] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const searchAbort = useRef<AbortController | null>(null);
  const saveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const saveInflight = useRef(new Map<string, Promise<boolean>>());
  const liveRef = useRef(true);
  const readOnlyRef = useRef(Boolean(props.readOnly));
  readOnlyRef.current = Boolean(props.readOnly);
  const active = state.activeId ? state.tabs.get(state.activeId) ?? null : null;
  const revision = props.catalogs.revisions["catalogs/documents.json"];
  const update = () => render((value) => value + 1);
  const envelope = (): Pick<ToonWorkspaceClientCommand, "operationId" | "expectedRevisions"> => ({ operationId: id("document"), expectedRevisions: revision ? { "catalogs/documents.json": revision } : {} });

  const refresh = async () => { await props.onCatalogsChange(); update(); };
  const openDocument = async (document: ToonDocumentDescriptor, pinned = false, reveal?: { line?: number; from?: number; to?: number }) => {
    let tab = state.tabs.get(document.id);
    if (!tab) {
      const response = await props.client.queryToonWorkspace(props.workspaceId, props.projectId, { kind: "document.read", documentId: document.id });
      if (response.kind !== "document.read") return;
      const recovery = readToonRecoveryDraft({ kind: "document", workspaceId: props.workspaceId, projectId: props.projectId, entityId: document.id });
      const recoveredDraft = typeof recovery?.content === "string" ? recovery.content : null;
      const revisionMismatch = recoveredDraft !== null && recovery?.revision !== response.revision;
      const draft = recoveredDraft ?? response.content;
      const from = reveal?.line ? documentOffsetForLine(response.content, reveal.line, reveal.from ?? 0) : reveal?.from ?? 0;
      tab = { id: document.id, kind: "document", title: document.title, document: response.document, preview: !pinned, draft, saved: response.content, revision: response.revision, view: { cursor: from, selection: { from, to: reveal?.line ? from + Math.max(0, (reveal.to ?? reveal.from ?? 0) - (reveal.from ?? 0)) : reveal?.to ?? from }, scrollTop: 0 }, conflict: revisionMismatch, ...(revisionMismatch ? { compare: response.content } : {}), reveal: reveal ? { from, to: reveal?.line ? from + Math.max(0, (reveal.to ?? reveal.from ?? 0) - (reveal.from ?? 0)) : reveal.to ?? from } : null };
      const preview = state.order.find((entry) => state.tabs.get(entry)?.preview);
      if (preview) { state.tabs.delete(preview); state.order = state.order.filter((entry) => entry !== preview); }
      state.tabs.set(document.id, tab); state.order.push(document.id);
    } else if (pinned) tab.preview = false;
    state.activeId = document.id; state.selectedId = document.id; update();
  };
  const openAsset = (asset: ToonAssetDescriptor, pinned = false) => {
    let tab = state.tabs.get(asset.id);
    if (!tab) {
      const preview = state.order.find((entry) => state.tabs.get(entry)?.preview);
      if (preview) { state.tabs.delete(preview); state.order = state.order.filter((entry) => entry !== preview); }
      tab = { id: asset.id, kind: "asset", title: asset.title, asset, preview: !pinned, draft: "", saved: "", revision: asset.checksum, view: { cursor: 0, selection: { from: 0, to: 0 }, scrollTop: 0 }, conflict: false };
      state.tabs.set(asset.id, tab); state.order.push(asset.id);
    } else if (pinned) tab.preview = false;
    state.activeId = asset.id; state.selectedId = asset.id; update();
  };
  const finishCloseTab = (tabId: string) => {
    const tab = state.tabs.get(tabId);
    if (!tab) return;
    const index = state.order.indexOf(tabId);
    state.tabs.delete(tabId); state.order = state.order.filter((entry) => entry !== tabId); state.recentlyClosed = [tabId, ...state.recentlyClosed.filter((entry) => entry !== tabId)].slice(0, 20);
    if (state.activeId === tabId) state.activeId = state.order[Math.min(index, state.order.length - 1)] ?? null;
    update();
  };
  const closeTab = async (tabId: string) => {
    const tab = state.tabs.get(tabId);
    if (!tab) return;
    if (tab.draft !== tab.saved) { setClosingTabId(tabId); return; }
    finishCloseTab(tabId);
  };
  const reopen = () => {
    const target = state.recentlyClosed.shift();
    const document = props.catalogs.documents.documents.find((item) => item.id === target);
    const asset = props.catalogs.assets.assets.find((item) => item.id === target);
    if (document) void openDocument(document, true); else if (asset) openAsset(asset, true);
  };
  async function save(tab: ToonDocumentTab, origin: "autosave" | "human-ui" = "autosave"): Promise<boolean> {
    const inflight = saveInflight.current.get(tab.id);
    if (inflight) {
      await inflight;
      return tab.draft === tab.saved || save(tab, origin);
    }
    if (readOnlyRef.current || tab.kind !== "document" || !tab.document || tab.draft === tab.saved || tab.conflict || !editableToonDocument(tab.document, tab.draft.length)) return tab.draft === tab.saved;
    const pending = prepareToonDocumentSave(tab, id(origin), origin);
    if (!pending) return true;
    const promise = (async () => {
      tab.saving = true;
      if (liveRef.current) update();
      try {
        const outcome = await props.client.executeToonWorkspaceCommand(props.workspaceId, props.projectId, { operationId: pending.operationId, expectedRevisions: { [tab.document!.path]: pending.revision }, kind: "document.write", documentId: tab.id, content: pending.content });
        const dirty = completeToonDocumentSave(tab, pending, outcome.revisions[tab.document!.path] ?? tab.revision);
        tab.conflict = false; tab.compare = undefined;
        if (!dirty) clearToonRecoveryDraft({ kind: "document", workspaceId: props.workspaceId, projectId: props.projectId, entityId: tab.id });
        await refresh();
        if (liveRef.current) { setError(null); update(); }
        if (dirty) scheduleSave(tab);
        return !dirty;
      } catch (cause) {
        writeToonRecoveryDraft({ kind: "document", workspaceId: props.workspaceId, projectId: props.projectId, entityId: tab.id, revision: tab.revision, content: tab.draft, updatedAt: new Date().toISOString() });
        if (conflict(cause)) {
          clearToonDocumentPendingSave(tab, pending);
          const latest = await props.client.queryToonWorkspace(props.workspaceId, props.projectId, { kind: "document.read", documentId: tab.id }).catch(() => null);
          tab.conflict = true; tab.compare = latest?.kind === "document.read" ? latest.content : undefined;
          if (liveRef.current) update();
        }
        if (liveRef.current) setError(cause instanceof Error ? cause.message : String(cause));
        if (!conflict(cause) && pending.attempts < 1) { pending.attempts += 1; scheduleSave(tab); }
        return false;
      } finally {
        tab.saving = false;
        saveInflight.current.delete(tab.id);
        if (liveRef.current) update();
      }
    })();
    saveInflight.current.set(tab.id, promise);
    return promise;
  }
  const scheduleSave = (tab: ToonDocumentTab) => {
    if (!props.visible || !liveRef.current) return;
    const current = saveTimers.current.get(tab.id); if (current) clearTimeout(current);
    saveTimers.current.set(tab.id, setTimeout(() => void save(tab), 400));
  };
  const reloadConflict = async (tab: ToonDocumentTab) => {
    if (tab.kind !== "document") return;
    const response = await props.client.queryToonWorkspace(props.workspaceId, props.projectId, { kind: "document.read", documentId: tab.id });
    if (response.kind !== "document.read") return;
    clearToonRecoveryDraft({ kind: "document", workspaceId: props.workspaceId, projectId: props.projectId, entityId: tab.id });
    Object.assign(tab, { draft: response.content, saved: response.content, revision: response.revision, document: response.document, conflict: false, compare: undefined, pendingSave: undefined, saving: false }); update();
  };
  const rebaseConflict = (tab: ToonDocumentTab) => { if (readOnlyRef.current) return; tab.conflict = false; tab.compare = undefined; tab.pendingSave = undefined; update(); scheduleSave(tab); };
  const saveConflictCopy = async (tab: ToonDocumentTab) => {
    if (readOnlyRef.current || !tab.document) return;
    const newId = id("document"); const path = tab.document.path.replace(/(\.[^./]+)?$/, `.conflict-${Date.now()}$1`);
    await props.client.executeToonWorkspaceCommand(props.workspaceId, props.projectId, { ...envelope(), kind: "document.create", document: { id: newId, title: `${tab.title} ${t("toon_factory.conflict_copy")}`, path, kind: tab.document.kind, mimeType: tab.document.mimeType, state: "active" }, content: tab.draft });
    const catalogs = await props.onCatalogsChange(); const copy = catalogs.documents.documents.find((item) => item.id === newId); if (copy) await openDocument(copy, true);
  };
  const runSearch = async () => {
    if (!query.trim()) { setResults(null); return; }
    searchAbort.current?.abort(); const controller = new AbortController(); searchAbort.current = controller; setSearching(true);
    try {
      let cursor = 0;
      let response: ToonDocumentSearchResponse = { items: [], scannedFiles: 0, scannedBytes: 0, truncated: false, nextCursor: 0 };
      do {
        const page = await props.client.searchToonDocuments(props.workspaceId, props.projectId, { query, mode: searchMode, limit: 50, cursor }, controller.signal);
        response = { items: [...response.items, ...page.items].slice(0, 200), scannedFiles: response.scannedFiles + page.scannedFiles, scannedBytes: response.scannedBytes + page.scannedBytes, truncated: page.truncated, nextCursor: page.nextCursor };
        setResults(response);
        if (response.items.length >= 200 || page.nextCursor === null || page.nextCursor <= cursor) break;
        cursor = page.nextCursor;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      } while (!controller.signal.aborted);
    }
    catch (cause) { if ((cause as Error)?.name !== "AbortError") setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (searchAbort.current === controller) setSearching(false); }
  };
  const execute = async (command: ToonWorkspaceClientCommand) => {
    if (readOnlyRef.current) throw new Error(t("toon_factory.lease_read_only"));
    await props.client.executeToonWorkspaceCommand(props.workspaceId, props.projectId, command);
    await refresh();
  };
  const createFile = async () => {
    if (readOnlyRef.current) return;
    const title = window.prompt(t("toon_factory.document_file_name"), "untitled.md"); if (!title) return;
    const selectedFolder = (props.catalogs.documents.folders ?? []).find((item) => item.id === state.selectedId);
    const name = extension(title, title.endsWith(".md") ? "markdown" : "text"); const documentId = id("document"); const path = `${selectedFolder?.path ?? "documents"}/${name}`;
    await execute({ ...envelope(), kind: "document.create", document: { id: documentId, title, path, kind: name.endsWith(".md") ? "markdown" : "text", mimeType: name.endsWith(".md") ? "text/markdown" : "text/plain", state: "active" }, content: "" });
    const catalogs = await props.onCatalogsChange(); const document = catalogs.documents.documents.find((item) => item.id === documentId); if (document) await openDocument(document, true);
  };
  const createFolder = async () => { if (readOnlyRef.current) return; const title = window.prompt(t("toon_factory.folder_name")); if (!title) return; const folderId = id("document-folder"); await execute({ ...envelope(), kind: "document.folder.create", folder: { id: folderId, title, path: `documents/${title.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase()}`, state: "active" } }); state.expanded.add(folderId); update(); };
  const moveDocument = async (document: ToonDocumentDescriptor, folderPath: string) => {
    if (readOnlyRef.current) return;
    const name = fileName(document.path);
    const path = `${folderPath}/${name}`;
    if (path !== document.path) await execute({ ...envelope(), kind: "document.rename", documentId: document.id, title: document.title, path });
  };
  const itemAction = async (action: "rename" | "copy" | "delete" | "restore") => {
    if (readOnlyRef.current) return;
    const document = props.catalogs.documents.documents.find((item) => item.id === state.selectedId);
    const folder = (props.catalogs.documents.folders ?? []).find((item) => item.id === state.selectedId);
    if (document) {
      if (action === "rename") { const title = window.prompt(t("toon_factory.document_file_name"), document.title); if (title) await execute({ ...envelope(), kind: "document.rename", documentId: document.id, title, path: `${document.path.slice(0, document.path.lastIndexOf("/"))}/${extension(title, document.kind)}` }); }
      if (action === "copy") await execute({ ...envelope(), kind: "document.copy", documentId: document.id, newDocumentId: id("document"), title: `${document.title} ${t("toon_factory.copy_suffix")}`, path: document.path.replace(/(\.[^./]+)?$/, `-copy$1`) });
      if (action === "delete") await execute({ ...envelope(), kind: "document.delete", documentId: document.id });
      if (action === "restore") await execute({ ...envelope(), kind: "document.restore", documentId: document.id });
    } else if (folder) {
      if (action === "rename") { const title = window.prompt(t("toon_factory.folder_name"), folder.title); if (title) await execute({ ...envelope(), kind: "document.folder.rename", folderId: folder.id, title, path: `${folder.path.slice(0, folder.path.lastIndexOf("/"))}/${title.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase()}` }); }
      if (action === "delete") await execute({ ...envelope(), kind: "document.folder.delete", folderId: folder.id, recursive: window.confirm(t("toon_factory.document_delete_folder")) });
      if (action === "restore") await execute({ ...envelope(), kind: "document.folder.restore", folderId: folder.id });
    }
  };
  const restoreRevision = async (tab: ToonDocumentTab, revisionId: string) => {
    if (readOnlyRef.current) return;
    await props.client.restoreToonDocumentRevision(props.workspaceId, props.projectId, tab.id, revisionId, { operationId: id("restore-document"), expectedRevision: tab.revision, actor: { kind: "human" }, origin: "human-ui" });
    await reloadConflict(tab);
    setHistoryOpen(false);
    await refresh();
  };
  const openHistory = async () => { if (!active || active.kind !== "document") return; setHistory((await props.client.listToonDocumentRevisions(props.workspaceId, props.projectId, active.id)).items); setHistoryOpen(true); };

  state.flushAllDirtyTabs = async () => {
    for (const timer of saveTimers.current.values()) clearTimeout(timer);
    saveTimers.current.clear();
    return flushAllDirtyTabs([...state.tabs.values()].filter((tab) => tab.kind === "document"), (tab) => save(tab, "human-ui"));
  };
  useEffect(() => () => {
    liveRef.current = false;
    searchAbort.current?.abort();
    for (const timer of saveTimers.current.values()) clearTimeout(timer);
    for (const tab of state.tabs.values()) if (tab.kind === "document" && tab.draft !== tab.saved) {
      writeToonRecoveryDraft({ kind: "document", workspaceId: props.workspaceId, projectId: props.projectId, entityId: tab.id, revision: tab.revision, content: tab.draft, updatedAt: new Date().toISOString() });
    }
    void state.flushAllDirtyTabs?.();
    state.flushAllDirtyTabs = undefined;
  }, []);
  useEffect(() => {
    if (!props.visible) {
      void state.flushAllDirtyTabs?.();
      searchAbort.current?.abort();
      for (const timer of saveTimers.current.values()) clearTimeout(timer);
      saveTimers.current.clear();
      return;
    }
    for (const tab of state.tabs.values()) if (tab.kind === "document" && tab.draft !== tab.saved && !tab.conflict) scheduleSave(tab);
    const key = (event: globalThis.KeyboardEvent) => {
      const command = event.metaKey || event.ctrlKey; const value = event.key.toLowerCase();
      if (command && value === "p") { event.preventDefault(); setSearchMode("filename"); setSearchOpen(true); setTimeout(() => searchRef.current?.focus(), 0); }
      else if (command && event.shiftKey && value === "f") { event.preventDefault(); setSearchMode("content"); setSearchOpen(true); setTimeout(() => searchRef.current?.focus(), 0); }
      else if (command && value === "w") { event.preventDefault(); if (state.activeId) void closeTab(state.activeId); }
      else if (command && event.shiftKey && value === "t") { event.preventDefault(); reopen(); }
    };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, [props.visible, props.catalogs]);
  useEffect(() => {
    if (!props.visible || active?.kind !== "asset" || !active.asset) { setPreviewUrl((url) => { if (url) URL.revokeObjectURL(url); return null; }); return; }
    const controller = new AbortController();
    const requestToken = `${active.id}:${active.revision}`;
    let live = true; let objectUrl: string | null = null;
    setPreviewUrl(null);
    const safe = /^(image\/(png|jpeg|gif|webp)|video\/(mp4|webm)|audio\/(mpeg|wav|ogg|mp4))$/.test(active.asset.mimeType);
    if (safe) void props.client.downloadToonProjectAsset(props.workspaceId, props.projectId, active.asset.id, true, controller.signal).then((download) => { if (!live || requestToken !== `${state.activeId}:${state.tabs.get(state.activeId ?? "")?.revision}`) return; objectUrl = URL.createObjectURL(new Blob([download.data], { type: download.contentType ?? active.asset!.mimeType })); setPreviewUrl(objectUrl); }).catch((cause) => { if ((cause as Error)?.name !== "AbortError" && live) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { live = false; controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [props.visible, active?.id, active?.revision]);
  useEffect(() => {
    for (const tab of state.tabs.values()) {
      if (tab.kind === "document") {
        const descriptor = props.catalogs.documents.documents.find((item) => item.id === tab.id);
        if (descriptor) { tab.document = descriptor; tab.title = descriptor.title; }
      } else {
        const descriptor = props.catalogs.assets.assets.find((item) => item.id === tab.id);
        if (descriptor) { tab.asset = descriptor; tab.title = descriptor.title; }
      }
    }
  }, [props.catalogs]);

  if (!props.visible) return <div data-testid="toon-v2-document-suspended" />;

  const entries = buildToonDocumentTree(props.catalogs.documents.documents, props.catalogs.documents.folders ?? [], props.catalogs.assets.assets, state.expanded);
  const treeKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = entries.findIndex((item) => item.id === state.selectedId);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); state.selectedId = entries[Math.max(0, Math.min(entries.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.id ?? null; update(); }
    if (event.key === "Enter" && index >= 0) { event.preventDefault(); const item = entries[index]!; if (item.kind === "folder") { state.expanded.has(item.id) ? state.expanded.delete(item.id) : state.expanded.add(item.id); update(); } else if (item.document) void openDocument(item.document, true); else if (item.asset) openAsset(item.asset, true); }
    if (event.key === "ArrowRight" && entries[index]?.kind === "folder") { state.expanded.add(entries[index]!.id); update(); }
    if (event.key === "ArrowLeft" && entries[index]?.kind === "folder") { state.expanded.delete(entries[index]!.id); update(); }
  };

  return <div className="flex h-full min-h-0 pt-16" data-testid="toon-document-workspace-v2">
    <aside className="flex shrink-0 flex-col border-r border-dls-border bg-background/80" style={{ width: state.sidebarWidth }}>
       <div className="flex items-center gap-1 border-b border-dls-border p-2"><button type="button" disabled={props.readOnly} title={props.readOnly ? t("toon_factory.lease_read_only") : t("toon_factory.create_folder")} onClick={() => void createFolder()} className="rounded p-1.5 hover:bg-dls-hover disabled:opacity-30"><FolderPlus className="size-3.5" /></button><button type="button" disabled={props.readOnly} title={props.readOnly ? t("toon_factory.lease_read_only") : t("toon_factory.document_create_file")} onClick={() => void createFile()} className="rounded p-1.5 hover:bg-dls-hover disabled:opacity-30"><FilePlus2 className="size-3.5" /></button><button type="button" disabled={props.readOnly} title={props.readOnly ? t("toon_factory.lease_read_only") : t("toon_factory.canvas_action_rename")} onClick={() => void itemAction("rename")} className="rounded p-1.5 hover:bg-dls-hover disabled:opacity-30"><MoreHorizontal className="size-3.5" /></button><button type="button" disabled={props.readOnly} title={props.readOnly ? t("toon_factory.lease_read_only") : t("toon_factory.canvas_action_duplicate")} onClick={() => void itemAction("copy")} className="rounded p-1.5 hover:bg-dls-hover disabled:opacity-30"><Copy className="size-3.5" /></button><button type="button" disabled={props.readOnly} title={props.readOnly ? t("toon_factory.lease_read_only") : t("toon_factory.canvas_action_delete")} onClick={() => void itemAction("delete")} className="rounded p-1.5 hover:bg-dls-hover disabled:opacity-30"><Trash2 className="size-3.5" /></button><button type="button" disabled={props.readOnly} title={props.readOnly ? t("toon_factory.lease_read_only") : t("toon_factory.canvas_action_restore")} onClick={() => void itemAction("restore")} className="rounded p-1.5 hover:bg-dls-hover disabled:opacity-30"><ArchiveRestore className="size-3.5" /></button></div>
       {props.catalogs.documents.documents.some((item) => item.id === state.selectedId) ? <label className="border-b border-dls-border px-2 py-1 text-[9px] text-dls-secondary" title={props.readOnly ? t("toon_factory.lease_read_only") : undefined}>{t("toon_factory.move_to_folder")}<select value={props.catalogs.documents.documents.find((item) => item.id === state.selectedId)?.path.slice(0, props.catalogs.documents.documents.find((item) => item.id === state.selectedId)!.path.lastIndexOf("/")) ?? "documents"} disabled={props.readOnly} onChange={(event) => { const document = props.catalogs.documents.documents.find((item) => item.id === state.selectedId); if (document) void moveDocument(document, event.target.value); }} className="ml-2 rounded border border-dls-border bg-background p-1 disabled:cursor-not-allowed disabled:opacity-40"><option value="documents">{t("toon_factory.no_folder")}</option>{(props.catalogs.documents.folders ?? []).filter((folder) => folder.state === "active").map((folder) => <option key={folder.id} value={folder.path}>{folder.title}</option>)}</select></label> : null}
      <div role="tree" tabIndex={0} onKeyDown={treeKey} className="min-h-0 flex-1 overflow-auto p-1 outline-none focus:ring-2 focus:ring-inset focus:ring-dls-accent" aria-label={t("toon_factory.document_files")}>{entries.map((item) => <button key={`${item.kind}:${item.id}`} type="button" role="treeitem" aria-level={item.depth + 1} aria-expanded={item.kind === "folder" ? state.expanded.has(item.id) : undefined} aria-selected={state.selectedId === item.id} onClick={() => { state.selectedId = item.id; if (item.kind === "folder") { state.expanded.has(item.id) ? state.expanded.delete(item.id) : state.expanded.add(item.id); update(); } else if (item.document) void openDocument(item.document); else if (item.asset) openAsset(item.asset); }} onDoubleClick={() => { if (item.document) void openDocument(item.document, true); else if (item.asset) openAsset(item.asset, true); }} className={cn("flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-[11px]", state.selectedId === item.id ? "bg-dls-active text-dls-accent" : "text-dls-secondary hover:bg-dls-hover", item.state !== "active" && "opacity-50")} style={{ paddingLeft: 6 + item.depth * 14 }}>{item.kind === "folder" ? state.expanded.has(item.id) ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" /> : item.kind === "asset" ? item.asset?.mimeType.startsWith("image/") ? <Image className="size-3" /> : item.asset?.mimeType.startsWith("video/") ? <Video className="size-3" /> : item.asset?.mimeType.startsWith("audio/") ? <Music className="size-3" /> : <File className="size-3" /> : <File className="size-3" />}<span className="truncate">{item.title}</span></button>)}</div>
      <div className={cn("h-full w-1 self-end", props.readOnly ? "cursor-not-allowed" : "cursor-col-resize")} onPointerDown={(event) => { if (props.readOnly) return; const start = event.clientX; const width = state.sidebarWidth; const move = (next: PointerEvent) => { state.sidebarWidth = Math.max(180, Math.min(420, width + next.clientX - start)); update(); }; const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); }; window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); }} />
    </aside>
    <section className="flex min-w-0 flex-1 flex-col">
      <div className="flex min-h-9 items-end overflow-x-auto border-b border-dls-border bg-[var(--app-list-bg)] px-1">{state.order.map((tabId) => { const tab = state.tabs.get(tabId)!; return <button key={tabId} type="button" onClick={() => { state.activeId = tabId; update(); }} onDoubleClick={() => { if (!props.readOnly) { tab.preview = false; update(); } }} className={cn("group flex max-w-52 items-center gap-2 border-r border-dls-border px-3 py-2 text-[10px]", state.activeId === tabId ? "bg-background text-dls-text" : "text-dls-secondary")}><span className="truncate">{tab.title}</span>{tab.preview ? <span className="italic">P</span> : <Pin className="size-2.5" />}{tab.draft !== tab.saved ? <span className="size-1.5 rounded-full bg-dls-accent" aria-label={t("toon_factory.document_dirty")} /> : null}<X className="size-3 opacity-0 group-hover:opacity-100" onClick={(event) => { event.stopPropagation(); void closeTab(tabId); }} /></button>; })}</div>
      <div className="flex h-10 items-center gap-2 border-b border-dls-border px-3"><button type="button" onClick={() => { setSearchOpen(!searchOpen); setTimeout(() => searchRef.current?.focus(), 0); }} className="rounded p-1.5 hover:bg-dls-hover" title={`${t("toon_factory.document_search")} (⌘P / ⇧⌘F)`}><Search className="size-3.5" /></button><button type="button" onClick={() => void openHistory()} disabled={active?.kind !== "document"} className="rounded p-1.5 disabled:opacity-30" title={t("toon_factory.document_history")}><History className="size-3.5" /></button><span className="min-w-0 flex-1 truncate text-[10px] text-dls-secondary">{active?.document?.path ?? active?.asset?.path ?? t("toon_factory.document_no_file")}</span>{active?.kind === "document" ? <span role="status" title={props.readOnly ? t("toon_factory.lease_read_only") : undefined} className={cn("text-[10px]", active.conflict ? "text-amber-600" : "text-dls-secondary")}>{props.readOnly ? t("toon_factory.document_read_only") : active.conflict ? t("toon_factory.save_conflict") : active.saving ? t("toon_factory.saving") : !editableToonDocument(active.document!, active.draft.length) ? t("toon_factory.document_read_only") : active.draft !== active.saved ? t("toon_factory.document_dirty") : t("toon_factory.saved")}</span> : null}</div>
      {searchOpen ? <form onSubmit={(event) => { event.preventDefault(); void runSearch(); }} className="border-b border-dls-border bg-background p-2"><div className="flex gap-2"><select value={searchMode} onChange={(event) => setSearchMode(event.target.value as typeof searchMode)} className="rounded-lg border border-dls-border bg-background px-2 text-[10px]"><option value="filename">{t("toon_factory.document_filename")}</option><option value="content">{t("toon_factory.document_content")}</option><option value="all">{t("toon_factory.document_all")}</option></select><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("toon_factory.document_search_placeholder")} className="min-w-0 flex-1 rounded-lg border border-dls-border bg-background px-3 py-1.5 text-xs outline-none focus:border-dls-accent" /><button type="submit" className="rounded-lg bg-dls-accent px-3 text-xs text-white">{searching ? t("toon_factory.document_searching") : t("toon_factory.document_search")}</button><button type="button" onClick={() => { searchAbort.current?.abort(); setSearching(false); }} className="rounded-lg border border-dls-border px-2 text-xs">{t("toon_factory.cancel_generation")}</button></div>{results ? <div className="mt-2 max-h-44 overflow-auto">{results.items.map((result, index) => <button key={`${result.documentId}:${result.match}:${result.line ?? 0}:${index}`} type="button" onClick={() => { const document = props.catalogs.documents.documents.find((item) => item.id === result.documentId); if (document) void openDocument(document, true, { line: result.line, from: result.from, to: result.to }); }} className="block w-full rounded-lg px-2 py-1.5 text-left text-[10px] hover:bg-dls-hover"><strong>{result.title}</strong> <span className="text-dls-secondary">{result.path}{result.line ? `:${result.line}` : ""}</span><span className="block truncate text-dls-secondary">{result.preview}</span></button>)}</div> : null}</form> : null}
      {error ? <div role="alert" className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[10px] text-amber-700">{error}</div> : null}
      {active?.conflict ? <div role="alert" className="border-b border-amber-500/30 bg-background p-3 text-xs"><strong>{t("toon_factory.save_conflict")}</strong><div className="mt-2 flex gap-2"><button type="button" onClick={() => void reloadConflict(active)} className="rounded border px-2 py-1">{t("toon_factory.discard_draft")}</button><button type="button" onClick={() => update()} className="rounded border px-2 py-1">{t("toon_factory.compare")}</button><button type="button" disabled={props.readOnly} title={props.readOnly ? t("toon_factory.lease_read_only") : undefined} onClick={() => void saveConflictCopy(active)} className="rounded border px-2 py-1 disabled:opacity-40">{t("toon_factory.save_conflict_copy")}</button><button type="button" disabled={props.readOnly} title={props.readOnly ? t("toon_factory.lease_read_only") : undefined} onClick={() => rebaseConflict(active)} className="rounded border px-2 py-1 disabled:opacity-40">{t("toon_factory.rebase_draft")}</button></div>{active.compare ? <div className="mt-2 grid grid-cols-2 gap-2"><pre className="max-h-40 overflow-auto bg-[var(--app-list-bg)] p-2 text-[9px]">{active.draft}</pre><pre className="max-h-40 overflow-auto bg-[var(--app-list-bg)] p-2 text-[9px]">{active.compare}</pre></div> : null}</div> : null}
      <div className="min-h-0 flex-1">{active?.kind === "document" && active.document ? <Suspense fallback={<div className="flex h-full items-center justify-center"><LoaderCircle className="size-4 animate-spin" /></div>}><ToonDocumentEditor key={`${active.id}:${active.revision}:${active.reveal?.from ?? -1}`} value={active.draft} view={active.view} readOnly={props.readOnly || !editableToonDocument(active.document, active.draft.length)} language={active.document.kind === "markdown" ? "markdown" : "text"} reveal={active.reveal} onChange={(value, view) => { if (props.readOnly) return; active.preview = false; active.draft = value; active.view = view; active.reveal = null; writeToonRecoveryDraft({ kind: "document", workspaceId: props.workspaceId, projectId: props.projectId, entityId: active.id, revision: active.revision, content: value, updatedAt: new Date().toISOString() }); update(); scheduleSave(active); }} onViewChange={(view) => { active.view = view; active.reveal = null; }} /></Suspense> : active?.kind === "asset" && active.asset ? <div className="flex h-full items-center justify-center overflow-auto p-8">{previewUrl && active.asset.mimeType.startsWith("image/") ? <img src={previewUrl} alt={active.title} className="max-h-full max-w-full object-contain" /> : previewUrl && active.asset.mimeType.startsWith("video/") ? <video src={previewUrl} controls preload="metadata" className="max-h-full max-w-full" /> : previewUrl && active.asset.mimeType.startsWith("audio/") ? <audio src={previewUrl} controls preload="metadata" /> : <div className="max-w-md rounded-xl border border-dls-border p-5 text-center"><File className="mx-auto size-6 text-dls-secondary" /><strong className="mt-2 block text-sm">{t("toon_factory.document_preview_unsupported")}</strong><span className="mt-1 block text-xs text-dls-secondary">{active.asset.mimeType} · {active.asset.bytes} bytes</span></div>}</div> : <div className="flex h-full items-center justify-center text-xs text-dls-secondary">{t("toon_factory.document_select_file")}</div>}</div>
    </section>
    {historyOpen && active?.kind === "document" ? <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/20 p-6" role="dialog" aria-modal="true"><div className="max-h-[75vh] w-full max-w-lg overflow-auto rounded-2xl border border-dls-border bg-background p-5 shadow-xl"><div className="flex items-center justify-between"><h2 className="text-sm font-semibold">{t("toon_factory.document_history")}</h2><button type="button" onClick={() => setHistoryOpen(false)}><X className="size-4" /></button></div><div className="mt-3 space-y-2">{history.map((revisionItem) => <div key={revisionItem.id} className="flex items-center justify-between rounded-xl border border-dls-border p-3 text-xs"><span><strong className="block">{revisionItem.revision.slice(0, 12)}</strong><span className="text-[10px] text-dls-secondary">{new Date(revisionItem.createdAt).toLocaleString()} · {revisionItem.origin} · {revisionItem.actor.kind}</span></span><button type="button" disabled={props.readOnly} title={props.readOnly ? t("toon_factory.lease_read_only") : undefined} onClick={() => void restoreRevision(active, revisionItem.id)} className="rounded-lg border border-dls-border px-2 py-1 disabled:opacity-40">{t("toon_factory.restore")}</button></div>)}</div></div></div> : null}
    {closingTabId && state.tabs.has(closingTabId) ? <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/20 p-6" role="dialog" aria-modal="true" aria-label={t("toon_factory.document_close_dirty")}><div className="w-full max-w-sm rounded-2xl border border-dls-border bg-background p-5 shadow-xl"><p className="text-sm">{t("toon_factory.document_close_dirty")}</p><div className="mt-4 flex justify-end gap-2"><button type="button" onClick={() => setClosingTabId(null)} className="rounded-lg border border-dls-border px-3 py-1.5 text-xs">{t("toon_factory.document_close_cancel")}</button><button type="button" onClick={() => { finishCloseTab(closingTabId); setClosingTabId(null); }} className="rounded-lg border border-destructive/50 px-3 py-1.5 text-xs text-destructive">{t("toon_factory.document_close_discard")}</button><button type="button" disabled={props.readOnly} title={props.readOnly ? t("toon_factory.lease_read_only") : undefined} onClick={() => { const tab = state.tabs.get(closingTabId); if (tab) void save(tab, "human-ui").then((clean) => { if (clean) { finishCloseTab(closingTabId); setClosingTabId(null); } }); }} className="rounded-lg bg-dls-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40">{t("toon_factory.document_close_save")}</button></div></div></div> : null}
  </div>;
}
