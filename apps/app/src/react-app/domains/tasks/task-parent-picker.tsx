import * as React from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { DenClient } from "@/app/lib/den";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";
import { productTaskKeys, type ProductTaskScope } from "./task-queries";

export function TaskParentPicker({ client, scope, taskId, pending, unavailable, error, onSave, onCancel, finalFocus }: {
  client: DenClient; scope: ProductTaskScope; taskId: string; pending: boolean; unavailable: string | null; error: string | null;
  onSave: (id: string) => void; onCancel: () => void; finalFocus: () => HTMLButtonElement | null;
}) {
  const [search, setSearch] = React.useState("");
  const [selected, select] = React.useState<string | null>(null);
  const term = search.trim();
  const query = useInfiniteQuery({
    queryKey: [...productTaskKeys.detail(scope, taskId), "parent-candidates", term], enabled: !unavailable,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => client.listProductTaskParentCandidates(scope.organizationId, taskId, { search: term, cursor: pageParam, limit: 30 }, { signal }),
    getNextPageParam: (page, _pages, _param, seen) => page.nextCursor && !seen.includes(page.nextCursor) ? page.nextCursor : undefined,
    gcTime: 0, refetchOnMount: "always", retry: false,
  });
  // Never offer a cached page while its permissions are being rechecked.
  const loading = query.isPending || query.isRefetching || query.isPaused || query.isPlaceholderData;
  const choices = unavailable || query.isError || loading ? [] : query.data?.pages.flatMap(page => page.items) ?? [];
  const canSave = !pending && !query.isFetching && choices.some(task => task.id === selected);
  const save = () => { if (canSave && selected) { select(null); onSave(selected); } };
  return <Dialog open onOpenChange={(open, details) => {
    if (open || pending) return;
    if (details.reason === "outside-press" && canSave) save();
    else onCancel();
  }}><DialogContent showCloseButton={false} finalFocus={finalFocus}>
    <DialogHeader><DialogTitle>{t("tasks.set_parent")}</DialogTitle><DialogDescription>{t("tasks.parent_picker_hint")}</DialogDescription></DialogHeader>
    <Input autoFocus aria-label={t("tasks.search")} placeholder={t("tasks.search")} value={search} disabled={pending || !!unavailable} onChange={e => { select(null); setSearch(e.target.value); }} />
    <div className="max-h-64 overflow-y-auto" aria-busy={query.isFetching}>
      {unavailable ? <p role="status">{unavailable}</p> : query.isError ? <p role="alert">{t("tasks.error_title")} <Button variant="ghost" onClick={() => { select(null); void query.refetch(); }}>{t("common.retry")}</Button></p>
        : loading ? <p role="status">{t("tasks.loading")}</p> : !choices.length && <p role="status">{t("tasks.no_matching_tasks")}</p>}
      {choices.map(task => <button type="button" key={task.id} aria-pressed={task.id === selected} disabled={pending} onClick={() => select(task.id)} className="flex w-full rounded-lg px-3 py-2 text-start hover:bg-dls-hover aria-pressed:bg-blue-100 aria-pressed:font-semibold">
        <span className="truncate">{task.title}</span>
      </button>)}
      {!unavailable && !loading && !query.isError && query.hasNextPage && <Button variant="ghost" disabled={pending || query.isFetching} onClick={() => void query.fetchNextPage({ cancelRefetch: false })}>{t("tasks.load_more")}</Button>}
    </div>
    {error && <p role="alert">{error}</p>}
    <DialogFooter><Button variant="outline" disabled={pending} onClick={onCancel}>{t("common.cancel")}</Button>
      <Button disabled={!canSave} onClick={save}>{t("common.save")}</Button></DialogFooter>
  </DialogContent></Dialog>;
}
