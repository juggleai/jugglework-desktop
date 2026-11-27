/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronUp, Flag, LoaderCircle, Pause, Pencil, Play, Plus, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "../../../../i18n";
import type { JuggleWorkGoalCriterionInput, JuggleWorkSessionGoal } from "../../../../app/lib/jugglework-server";
import { canContinueGoal, goalCriteriaProgress, isGoalUnfinished } from "./use-session-goal";

export type GoalCriterionDraft = { key: string; id?: string; text: string; required: boolean };
export type GoalDraft = { objective: string; criteria: GoalCriterionDraft[] };

let draftKey = 0;
const nextKey = () => `criterion-${++draftKey}`;

export function emptyGoalDraft(): GoalDraft {
  return { objective: "", criteria: [{ key: nextKey(), text: "", required: true }] };
}

export function goalDraftFromGoal(goal: JuggleWorkSessionGoal): GoalDraft {
  return {
    objective: goal.objective,
    criteria: goal.criteria.map((criterion) => ({ key: nextKey(), id: criterion.id, text: criterion.text, required: criterion.required })),
  };
}

/**
 * Turn the dialog draft into an API payload. Blank criteria rows are dropped;
 * the goal needs an objective and at least one required criterion.
 */
export function goalDraftPayload(draft: GoalDraft):
  | { ok: true; objective: string; criteria: JuggleWorkGoalCriterionInput[] }
  | { ok: false; error: "objective" | "criteria" } {
  const objective = draft.objective.trim();
  if (!objective) return { ok: false, error: "objective" };
  const criteria = draft.criteria
    .map((criterion) => ({ ...(criterion.id ? { id: criterion.id } : {}), text: criterion.text.trim(), required: criterion.required }))
    .filter((criterion) => criterion.text.length > 0);
  if (!criteria.some((criterion) => criterion.required)) return { ok: false, error: "criteria" };
  return { ok: true, objective, criteria };
}

export function GoalSetupDialog(props: {
  open: boolean;
  mode: "create" | "edit";
  initial: GoalDraft;
  continuationCap: number;
  /** Plan mode is selected; starting the goal will turn it off. */
  planModeSelected: boolean;
  submitting: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (payload: { objective: string; criteria: JuggleWorkGoalCriterionInput[] }) => void;
}) {
  const [draft, setDraft] = useState<GoalDraft>(props.initial);
  const [validation, setValidation] = useState<"objective" | "criteria" | null>(null);
  useEffect(() => {
    if (props.open) {
      setDraft(props.initial);
      setValidation(null);
    }
  }, [props.open, props.initial]);

  const updateCriterion = (key: string, patch: Partial<GoalCriterionDraft>) =>
    setDraft((current) => ({ ...current, criteria: current.criteria.map((item) => item.key === key ? { ...item, ...patch } : item) }));

  const submit = () => {
    const payload = goalDraftPayload(draft);
    if (!payload.ok) {
      setValidation(payload.error);
      return;
    }
    props.onSubmit({ objective: payload.objective, criteria: payload.criteria });
  };

  return (
    <Dialog open={props.open} onOpenChange={(open) => { if (!props.submitting) props.onOpenChange(open); }}>
      <DialogContent className="flex max-h-[85vh] w-full max-w-lg flex-col sm:max-w-lg" data-testid="goal-setup-dialog">
        <DialogHeader>
          <DialogTitle>{props.mode === "create" ? t("goal.setup_title") : t("goal.edit_title")}</DialogTitle>
          {props.mode === "create" ? (
            <DialogDescription>{t("goal.setup_description", { cap: props.continuationCap })}</DialogDescription>
          ) : null}
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-gray-11">{t("goal.objective_label")}</span>
            <textarea
              data-testid="goal-objective"
              className="min-h-20 w-full resize-y rounded-xl border border-dls-border bg-transparent px-3 py-2 text-sm text-gray-12 outline-none focus-visible:ring-2 focus-visible:ring-gray-7"
              placeholder={t("goal.objective_placeholder")}
              value={draft.objective}
              maxLength={4000}
              onChange={(event) => setDraft((current) => ({ ...current, objective: event.target.value }))}
            />
            {validation === "objective" ? <span className="text-xs text-red-11">{t("goal.validation_objective")}</span> : null}
          </label>
          <div className="space-y-1.5">
            <div className="text-xs font-medium text-gray-11">{t("goal.criteria_label")}</div>
            <div className="text-xs text-gray-9">{t("goal.criteria_hint")}</div>
            {draft.criteria.map((criterion) => (
              <div key={criterion.key} className="flex items-center gap-2" data-testid="goal-criterion-row">
                <input
                  className="h-9 min-w-0 flex-1 rounded-xl border border-dls-border bg-transparent px-3 text-sm text-gray-12 outline-none focus-visible:ring-2 focus-visible:ring-gray-7"
                  placeholder={t("goal.criterion_placeholder")}
                  value={criterion.text}
                  maxLength={500}
                  onChange={(event) => updateCriterion(criterion.key, { text: event.target.value })}
                />
                <label className="flex shrink-0 items-center gap-1 text-xs text-gray-10">
                  <input
                    type="checkbox"
                    checked={criterion.required}
                    onChange={(event) => updateCriterion(criterion.key, { required: event.target.checked })}
                  />
                  {t("goal.criterion_required")}
                </label>
                <button
                  type="button"
                  className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-gray-9 hover:bg-gray-3 hover:text-gray-12 disabled:opacity-40"
                  aria-label={t("goal.criterion_remove")}
                  title={t("goal.criterion_remove")}
                  disabled={draft.criteria.length <= 1}
                  onClick={() => setDraft((current) => ({ ...current, criteria: current.criteria.filter((item) => item.key !== criterion.key) }))}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-lg px-1.5 py-1 text-xs text-gray-11 hover:bg-gray-3 disabled:opacity-40"
              disabled={draft.criteria.length >= 20}
              onClick={() => setDraft((current) => ({ ...current, criteria: [...current.criteria, { key: nextKey(), text: "", required: true }] }))}
            >
              <Plus size={14} />
              {t("goal.criterion_add")}
            </button>
            {validation === "criteria" ? <div className="text-xs text-red-11">{t("goal.validation_criteria")}</div> : null}
          </div>
          {props.mode === "create" && props.planModeSelected ? (
            <div className="rounded-xl bg-gray-3 px-3 py-2 text-xs text-gray-11">{t("goal.plan_mode_cleared")}</div>
          ) : null}
          {props.error ? <div className="text-xs text-red-11">{props.error}</div> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={props.submitting} onClick={() => props.onOpenChange(false)}>{t("goal.cancel_setup")}</Button>
          <Button data-testid="goal-submit" disabled={props.submitting} onClick={submit}>
            {props.submitting ? <LoaderCircle size={14} className="animate-spin" /> : null}
            {props.mode === "create" ? t("goal.start") : t("goal.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function executionLabel(goal: JuggleWorkSessionGoal): string {
  if (goal.status !== "active") return t(`goal.status_${goal.status}`);
  return t(`goal.execution_${goal.execution}`);
}

/**
 * Persistent goal summary above the composer. It shows the durable goal, not
 * the current run's todos; the todo panel stays separate below it.
 */
export function GoalCard(props: {
  goal: JuggleWorkSessionGoal;
  sessionRunning: boolean;
  pending: boolean;
  error: string | null;
  onContinue: () => void;
  onPause: () => void;
  onResume: () => void;
  onEdit: () => void;
  onComplete: () => void;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { goal } = props;
  const progress = useMemo(() => goalCriteriaProgress(goal), [goal]);
  const unfinished = isGoalUnfinished(goal);
  const continuable = canContinueGoal(goal, props.sessionRunning) && !props.pending;
  const iconButton = "inline-flex h-7 items-center gap-1 rounded-lg px-2 text-xs text-gray-11 transition-colors hover:bg-gray-4 hover:text-gray-12 disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <div className="border-b border-dls-border px-4 py-2.5" data-testid="goal-card" data-goal-status={goal.status} data-goal-execution={goal.execution}>
      <div className="flex min-w-0 items-center gap-2">
        <Flag size={14} className="shrink-0 text-gray-10" aria-hidden="true" />
        <span className="shrink-0 text-xs font-medium text-gray-11">{t("goal.card_label")}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-gray-12" title={goal.objective}>{goal.objective}</span>
        <span className="shrink-0 rounded-full bg-gray-3 px-2 py-0.5 text-[11px] text-gray-11" data-testid="goal-execution">{executionLabel(goal)}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 pl-6 text-xs text-gray-9">
        <span data-testid="goal-criteria-progress">{t("goal.criteria_progress", { done: progress.done, total: progress.total })}</span>
        {unfinished ? (
          <span data-testid="goal-continuations">{t("goal.continuations", { used: goal.continuationStreak, cap: goal.continuationCap })}</span>
        ) : null}
        <div className="ml-auto flex items-center gap-0.5">
          <button type="button" className={iconButton} onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}
            aria-label={expanded ? t("goal.action_collapse") : t("goal.action_expand")} title={expanded ? t("goal.action_collapse") : t("goal.action_expand")}>
            {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
          {unfinished ? (
            <>
              {goal.status === "active" ? (
                <button type="button" className={iconButton} disabled={!continuable} onClick={props.onContinue} data-testid="goal-continue">
                  {props.pending ? <LoaderCircle size={13} className="animate-spin" /> : <Play size={13} />}
                  {t("goal.action_continue")}
                </button>
              ) : (
                <button type="button" className={iconButton} disabled={props.pending} onClick={props.onResume} data-testid="goal-resume">
                  <Play size={13} />{t("goal.action_resume")}
                </button>
              )}
              {goal.status === "active" ? (
                <button type="button" className={iconButton} disabled={props.pending} onClick={props.onPause} data-testid="goal-pause">
                  <Pause size={13} />{t("goal.action_pause")}
                </button>
              ) : null}
              <button type="button" className={iconButton} disabled={props.pending} onClick={props.onEdit} data-testid="goal-edit"
                aria-label={t("goal.action_edit")} title={t("goal.action_edit")}>
                <Pencil size={13} />
              </button>
              <button type="button" className={iconButton} disabled={props.pending} onClick={props.onComplete} data-testid="goal-complete"
                aria-label={t("goal.action_complete")} title={t("goal.action_complete")}>
                <Check size={13} />
              </button>
              <button type="button" className={iconButton} disabled={props.pending} onClick={props.onCancel} data-testid="goal-cancel"
                aria-label={t("goal.action_cancel")} title={t("goal.action_cancel")}>
                <X size={13} />
              </button>
            </>
          ) : (
            <button type="button" className={iconButton} onClick={props.onDismiss} data-testid="goal-dismiss"
              aria-label={t("goal.action_dismiss")} title={t("goal.action_dismiss")}>
              <X size={13} />
            </button>
          )}
        </div>
      </div>
      {unfinished && goal.blockerReason ? (
        <div className="mt-1.5 pl-6 text-xs text-amber-11" data-testid="goal-blocker">
          {t(goal.status === "blocked" ? "goal.blocked_reason" : "goal.waiting_reason", { reason: goal.blockerReason })}
        </div>
      ) : null}
      {expanded ? (
        <ul className="mt-2 max-h-48 space-y-1.5 overflow-auto pl-6" data-testid="goal-criteria">
          {goal.criteria.map((criterion) => (
            <li key={criterion.id} className="flex items-start gap-2 text-sm">
              <span className={`mt-0.5 shrink-0 rounded-full px-1.5 text-[10px] ${criterion.status === "met" ? "bg-green-3 text-green-11" : criterion.status === "waived" ? "bg-gray-3 text-gray-10" : "bg-gray-2 text-gray-9"}`}>
                {t(`goal.criterion_status_${criterion.status}`)}
              </span>
              <span className="min-w-0 flex-1">
                <span className={criterion.required ? "text-gray-12" : "text-gray-10"}>{criterion.text}</span>
                {criterion.evidence ? <span className="block text-xs text-gray-9" data-testid="goal-criterion-evidence">{criterion.evidence}</span> : null}
              </span>
            </li>
          ))}
          {goal.checkpoint ? (
            <li className="text-xs text-gray-9 whitespace-pre-wrap" data-testid="goal-checkpoint">
              <span className="font-medium text-gray-10">{t("goal.checkpoint_label")} </span>{goal.checkpoint}
            </li>
          ) : null}
        </ul>
      ) : null}
      {props.error ? <div className="mt-1 pl-6 text-xs text-red-11">{props.error}</div> : null}
    </div>
  );
}
