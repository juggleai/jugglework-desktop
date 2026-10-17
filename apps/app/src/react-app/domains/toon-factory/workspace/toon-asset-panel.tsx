/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import { Download, FileAudio, FileText, Film, FolderTree, Grid2X2, Image, List, Paperclip, RotateCcw, Search, Trash2, Upload, X } from "lucide-react";
import type { JuggleWorkServerClient } from "@/app/lib/jugglework-server";
import type { ToonAssetDescriptor, ToonWorkspaceOperationOutcome, ToonWorkspaceQueryResponse } from "@jugglework/types/toon-workspace";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";

type AssetClient = Pick<JuggleWorkServerClient, "queryToonWorkspace" | "executeToonWorkspaceCommand" | "uploadToonProjectAsset" | "downloadToonProjectAsset">;

export function ToonAssetPanel(props: {
  client: AssetClient;
  workspaceId: string;
  projectId: string;
  readOnly?: boolean;
  assets: ToonAssetDescriptor[];
  catalogRevision?: string;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
  onReuse: (asset: ToonAssetDescriptor) => void;
  onAttach: (asset: ToonAssetDescriptor) => void;
}) {
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"tree" | "grid" | "list">("grid");
  const [showTrash, setShowTrash] = useState(false);
  const [selected, setSelected] = useState<ToonAssetDescriptor | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [impacts, setImpacts] = useState<Array<{ source: string; id: string; label: string; historical: boolean }>>([]);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const previewAbortRef = useRef<AbortController | null>(null);
  const previewTokenRef = useRef(0);
  const filtered = props.assets.filter((asset) => (showTrash ? asset.state !== "active" : asset.state === "active") && (!query || `${asset.title} ${asset.path} ${asset.mimeType}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())));

  const previewUrlRef = useRef<string | null>(null);
  useEffect(() => () => { previewTokenRef.current += 1; previewAbortRef.current?.abort(); if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current); }, []);

  const select = async (asset: ToonAssetDescriptor) => {
    previewAbortRef.current?.abort();
    const controller = new AbortController();
    previewAbortRef.current = controller;
    const token = ++previewTokenRef.current;
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = null;
    setPreviewUrl(null); setSelected(asset); setError(null);
    try {
      const response = await props.client.queryToonWorkspace(props.workspaceId, props.projectId, { kind: "asset.references", assetId: asset.id });
      setImpacts(response.kind === "asset.references" ? response.impacts : []);
      if (asset.state === "active" && /^(?:image|video|audio)\//.test(asset.mimeType)) {
        const binary = await props.client.downloadToonProjectAsset(props.workspaceId, props.projectId, asset.id, true, controller.signal);
        if (controller.signal.aborted || token !== previewTokenRef.current) return;
        const url = URL.createObjectURL(new Blob([binary.data], { type: binary.contentType ?? asset.mimeType }));
        if (controller.signal.aborted || token !== previewTokenRef.current) { URL.revokeObjectURL(url); return; }
        previewUrlRef.current = url; setPreviewUrl(url);
      }
    } catch (cause) { if ((cause as Error)?.name !== "AbortError" && token === previewTokenRef.current) setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const upload = async (file: File) => {
    if (props.readOnly) return;
    setError(null);
    try {
      await props.client.uploadToonProjectAsset(props.workspaceId, props.projectId, file, { operationId: operationId("asset-upload"), assetId: operationId("asset"), filename: file.name, ...(file.type ? { declaredMimeType: file.type } : {}), origin: "imported", actor: { kind: "human" } });
      await props.onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const mutate = async (asset: ToonAssetDescriptor, action: "delete" | "restore") => {
    if (props.readOnly) return;
    try {
      let destructive = false;
      if (action === "delete" && impacts.length) destructive = window.confirm(t("toon_factory.asset_delete_referenced", { count: impacts.length }));
      if (action === "delete" && impacts.length && !destructive) return;
      const expectedRevisions: Record<string, string | null> = props.catalogRevision ? { "catalogs/assets.json": props.catalogRevision } : {};
      const envelope = { operationId: operationId(`asset-${action}`), expectedRevisions };
      if (action === "delete") await props.client.executeToonWorkspaceCommand(props.workspaceId, props.projectId, { ...envelope, kind: "asset.delete", assetId: asset.id, destructive });
      else await props.client.executeToonWorkspaceCommand(props.workspaceId, props.projectId, { ...envelope, kind: "asset.restore", assetId: asset.id });
      setSelected(null); setImpacts([]); await props.onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const download = async (asset: ToonAssetDescriptor) => {
    const binary = await props.client.downloadToonProjectAsset(props.workspaceId, props.projectId, asset.id);
    const url = URL.createObjectURL(new Blob([binary.data], { type: binary.contentType ?? asset.mimeType }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = binary.filename ?? asset.title; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return <aside className="absolute inset-y-3 right-3 z-40 flex w-[min(720px,calc(100%-1.5rem))] overflow-hidden rounded-2xl border border-dls-border bg-background shadow-xl max-[720px]:inset-3 max-[720px]:w-auto max-[720px]:flex-col" role="dialog" aria-modal="true" aria-label={t("toon_factory.project_assets")} data-testid="toon-asset-panel" onKeyDown={(event) => { if (event.key === "Escape") props.onClose(); }}>
    <section className="flex min-w-0 flex-1 flex-col p-3">
      <header className="flex items-center gap-2"><strong className="text-sm">{t("toon_factory.project_assets")}</strong><label className="ml-auto flex items-center gap-1 rounded-lg border border-dls-border px-2"><Search className="size-3" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("toon_factory.search_assets")} aria-label={t("toon_factory.search_assets")} className="h-8 w-40 bg-transparent text-xs outline-none" /></label><div className="flex rounded-lg border border-dls-border p-0.5" aria-label={t("toon_factory.asset_view")}><button type="button" title={t("toon_factory.tree_view")} aria-pressed={view === "tree"} onClick={() => setView("tree")} className="rounded p-1.5"><FolderTree className="size-3.5" /></button><button type="button" title={t("toon_factory.grid_view")} aria-pressed={view === "grid"} onClick={() => setView("grid")} className="rounded p-1.5"><Grid2X2 className="size-3.5" /></button><button type="button" title={t("toon_factory.list_view")} aria-pressed={view === "list"} onClick={() => setView("list")} className="rounded p-1.5"><List className="size-3.5" /></button></div><button type="button" aria-label={t("toon_factory.close_assets")} onClick={props.onClose}><X className="size-4" /></button></header>
       <div className="mt-3 flex items-center gap-2"><button type="button" disabled={props.readOnly} title={props.readOnly ? t("toon_factory.lease_read_only") : undefined} onClick={() => inputRef.current?.click()} className="flex items-center gap-1 rounded-lg bg-dls-accent px-3 py-2 text-xs font-semibold text-white disabled:opacity-40"><Upload className="size-3.5" />{t("toon_factory.import_asset")}</button><input ref={inputRef} type="file" hidden accept="image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm,audio/wav,audio/mpeg,audio/ogg,text/plain,.md" onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); event.currentTarget.value = ""; }} /><button type="button" aria-pressed={showTrash} onClick={() => setShowTrash(!showTrash)} className="rounded-lg border border-dls-border px-3 py-2 text-xs">{showTrash ? t("toon_factory.asset_library") : t("toon_factory.trash")}</button><span role="status" aria-live="polite" className="text-[10px] text-dls-secondary">{t("toon_factory.asset_count", { count: filtered.length })}</span></div>
      {error ? <p role="alert" className="mt-2 rounded-lg bg-destructive/10 p-2 text-xs text-destructive">{error}</p> : null}
      <div className={cn("mt-3 min-h-0 flex-1 overflow-auto", view === "grid" ? "grid auto-rows-min grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-2" : "space-y-1")}>
        {view === "tree" ? [...groupAssets(filtered)].map(([folder, assets]) => <section key={folder} className="rounded-xl border border-dls-border p-2"><h3 className="flex items-center gap-1 text-[10px] font-semibold"><FolderTree className="size-3" />{folder}</h3><div className="mt-1 space-y-1">{assets.map((asset) => <AssetButton key={asset.id} asset={asset} selected={selected?.id === asset.id} view="list" onSelect={select} />)}</div></section>) : filtered.map((asset) => <AssetButton key={asset.id} asset={asset} selected={selected?.id === asset.id} view={view} onSelect={select} />)}
      </div>
    </section>
    {selected ? <section className="w-64 shrink-0 overflow-y-auto border-l border-dls-border bg-[var(--app-list-bg)] p-3"><div className="aspect-video overflow-hidden rounded-xl border border-dls-border bg-background">{previewUrl && selected.mimeType.startsWith("image/") ? <img src={previewUrl} alt={selected.title} className="h-full w-full object-contain" /> : previewUrl && selected.mimeType.startsWith("video/") ? <video src={previewUrl} controls className="h-full w-full" /> : previewUrl && selected.mimeType.startsWith("audio/") ? <audio src={previewUrl} controls className="h-full w-full" /> : <div className="flex h-full items-center justify-center"><AssetIcon asset={selected} /></div>}</div><h3 className="mt-3 text-xs font-semibold">{selected.title}</h3><dl className="mt-2 space-y-1 break-all text-[9px] text-dls-secondary"><div>{selected.path}</div><div>{selected.mimeType} · {formatBytes(selected.bytes)}</div><div>SHA-256 {selected.checksum}</div>{selected.width ? <div>{selected.width} × {selected.height}</div> : null}{selected.durationSeconds ? <div>{selected.durationSeconds.toFixed(2)}s</div> : null}<div>{selected.origin} · {selected.state}</div></dl><div className="mt-3 grid grid-cols-2 gap-1"><button type="button" onClick={() => props.onReuse(selected)} disabled={props.readOnly || selected.state !== "active" || selected.mimeType.startsWith("audio/")} className="rounded border border-dls-border px-2 py-1.5 text-[10px] disabled:opacity-40">Reuse</button><button type="button" onClick={() => props.onAttach(selected)} disabled={selected.state !== "active"} className="rounded border border-dls-border px-2 py-1.5 text-[10px] disabled:opacity-40"><Paperclip className="mr-1 inline size-3" />Attach</button><button type="button" onClick={() => void download(selected)} disabled={selected.state !== "active"} className="rounded border border-dls-border px-2 py-1.5 text-[10px] disabled:opacity-40"><Download className="mr-1 inline size-3" />Download</button>{selected.state === "trashed" ? <button type="button" disabled={props.readOnly} onClick={() => void mutate(selected, "restore")} className="rounded border border-dls-border px-2 py-1.5 text-[10px]"><RotateCcw className="mr-1 inline size-3" />Restore</button> : <button type="button" disabled={props.readOnly} onClick={() => void mutate(selected, "delete")} className="rounded border border-destructive/30 px-2 py-1.5 text-[10px] text-destructive"><Trash2 className="mr-1 inline size-3" />Trash</button>}</div>{impacts.length ? <div className="mt-3"><strong className="text-[10px]">Delete impact</strong>{impacts.map((impact) => <div key={`${impact.source}:${impact.id}`} className="mt-1 rounded bg-background p-2 text-[9px]"><span className="font-semibold">{impact.source}</span> {impact.label}{impact.historical ? " · retained history" : ""}</div>)}</div> : null}</section> : null}
  </aside>;
}

function AssetIcon({ asset }: { asset: ToonAssetDescriptor }) {
  const className = "size-8 shrink-0 text-dls-secondary";
  if (asset.mimeType.startsWith("image/")) return <Image className={className} />;
  if (asset.mimeType.startsWith("video/")) return <Film className={className} />;
  if (asset.mimeType.startsWith("audio/")) return <FileAudio className={className} />;
  return <FileText className={className} />;
}
function AssetButton(props: { asset: ToonAssetDescriptor; selected: boolean; view: "grid" | "list"; onSelect: (asset: ToonAssetDescriptor) => Promise<void> }) {
  return <button type="button" onClick={() => void props.onSelect(props.asset)} className={cn("border border-dls-border text-left hover:border-dls-accent", props.view === "grid" ? "rounded-xl p-2" : "flex w-full items-center gap-2 rounded-lg px-2 py-2", props.selected && "border-dls-accent bg-dls-active")}><AssetIcon asset={props.asset} /><span className="min-w-0"><strong className="block truncate text-[11px]">{props.asset.title}</strong><span className="block truncate text-[9px] text-dls-secondary">{props.asset.mimeType} · {formatBytes(props.asset.bytes)}</span></span></button>;
}
function groupAssets(assets: ToonAssetDescriptor[]): Map<string, ToonAssetDescriptor[]> {
  const groups = new Map<string, ToonAssetDescriptor[]>();
  for (const asset of assets) { const folder = asset.path.split("/").slice(0, -1).join("/") || "assets"; groups.set(folder, [...(groups.get(folder) ?? []), asset]); }
  return groups;
}
function formatBytes(bytes: number): string { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function operationId(prefix: string): string { return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`; }
