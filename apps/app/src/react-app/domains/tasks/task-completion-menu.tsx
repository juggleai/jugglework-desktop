import { useState } from "react";
import { Info } from "lucide-react";
import type { DenProductTaskResult } from "@/app/lib/den";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { t } from "@/i18n";

export type TaskCompletionAction = "complete" | "complete-whole" | "reopen-mine" | "reopen";

export function TaskCompletionMenu({ detail, memberId, anchor, onClose, onSelect }: {
  detail: DenProductTaskResult;
  memberId: string | null;
  anchor?: HTMLElement;
  onClose: () => void;
  onSelect: (action: TaskCompletionAction) => void;
}) {
  const [confirmation, setConfirmation] = useState<"complete-whole" | "reopen" | null>(null);
  const assignees = detail.members.filter((member) => member.role === "assignee");
  const mine = assignees.find((member) => member.memberId === memberId);
  const isDone = detail.task.status === "completed";
  const reopenMine = isDone || Boolean(mine?.completedAt);
  const chooseEveryone = () => {
    if (isDone) setConfirmation("reopen");
    else if (assignees.some((member) => !member.completedAt)) setConfirmation("complete-whole");
    else onSelect("complete-whole");
  };

  if (confirmation) {
    const reopen = confirmation === "reopen";
    return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent showCloseButton={false} className="rounded-xl sm:max-w-[420px]">
        <DialogHeader className="relative pl-9">
          <Info aria-hidden="true" className="absolute left-0 top-0.5 size-5 rounded-full bg-blue-9 text-white" />
          <DialogTitle>{t(reopen ? "tasks.reopen" : "tasks.complete")}</DialogTitle>
          <DialogDescription className="pt-1 text-dls-text">{t(reopen ? "tasks.reopen_all_message" : "tasks.complete_all_message")}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="mx-0 mb-0 border-0 bg-transparent p-0 pt-2">
          <Button variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
          <Button className="bg-blue-9 text-white hover:bg-blue-10" onClick={() => onSelect(confirmation)}>{t(reopen ? "tasks.confirm_reopen" : "tasks.confirm_complete")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>;
  }
  return <DropdownMenu open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DropdownMenuContent anchor={anchor} align="start" aria-label={t("tasks.completion_actions")} className="w-max min-w-36 rounded-lg border border-dls-border bg-dls-surface p-1 text-dls-text">
      {mine && <DropdownMenuItem closeOnClick={false} disabled={reopenMine ? !detail.permissions.canReopen : !detail.permissions.canComplete} onClick={() => onSelect(reopenMine ? "reopen-mine" : "complete")}>
        {t(reopenMine ? "tasks.reopen_mine" : "tasks.complete_mine")}
      </DropdownMenuItem>}
      <DropdownMenuItem closeOnClick={false} disabled={isDone ? !detail.permissions.canReopen : !detail.permissions.canCompleteWhole} onClick={chooseEveryone}>
        {t(isDone ? "tasks.reopen_all" : "tasks.complete_all")}
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}
