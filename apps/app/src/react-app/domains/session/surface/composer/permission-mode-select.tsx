/**
 * Session permission mode selector for the conversation composer.
 *
 * Compact, portalled, viewport-bounded selector showing `Request approval` /
 * `Full access` (with paused/suspended fail-closed states). Enabling Full
 * access requires an explicit versioned risk acknowledgement dialog. Only the
 * warning icon uses warning styling; the label stays toolbar-neutral.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronsUpDown, ShieldCheck, ShieldQuestion, TriangleAlert } from "lucide-react";

import type {
  SessionPermissionEffectiveMode,
  SessionPermissionGrantRecord,
  SessionPermissionModeChoice,
} from "@jugglework/types/session-permission-modes";
import { readSessionFullAccessPolicy } from "@jugglework/types/den/desktop-policies";
import type { DenDesktopConfig } from "@/app/lib/den";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

export type PermissionModeSelectorProps = {
  requestedMode: SessionPermissionModeChoice | null;
  effectiveMode: SessionPermissionEffectiveMode | null;
  grants: SessionPermissionGrantRecord[];
  disabledReason: string | null;
  busy: boolean;
  running: boolean;
  desktopConfig: DenDesktopConfig | null;
  onSelectRequestApproval: () => void;
  onSelectFullAccess: () => void;
};

function describeMode(effectiveMode: SessionPermissionEffectiveMode | null): {
  label: string;
  icon: typeof ShieldCheck;
  iconClass: string;
} {
  if (effectiveMode === "full-access" || effectiveMode === "full-access-paused" || effectiveMode === "full-access-suspended") {
    return {
      label: effectiveMode === "full-access"
        ? t("session.permission_mode_full_access")
        : effectiveMode === "full-access-paused"
          ? t("session.permission_mode_paused")
          : t("session.permission_mode_suspended"),
      icon: effectiveMode === "full-access" ? TriangleAlert : ShieldQuestion,
      iconClass: "text-orange-9",
    };
  }
  return { label: t("session.permission_mode_request_approval"), icon: ShieldCheck, iconClass: "" };
}

export function PermissionModeSelect(props: PermissionModeSelectorProps) {
  const [open, setOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const confirmationArmedRef = useRef(false);

  const policy = useMemo(
    () => readSessionFullAccessPolicy(props.desktopConfig?.allowSessionFullAccess),
    [props.desktopConfig?.allowSessionFullAccess],
  );

  const current = describeMode(props.effectiveMode);
  const fullAccessActive = props.effectiveMode === "full-access";
  const runningHint = props.running ? t("session.permission_mode_running_hint") : null;

  // Reset an unconfirmed acknowledgement dialog whenever the selector closes.
  useEffect(() => {
    if (!open) confirmationArmedRef.current = false;
  }, [open]);

  const handleSelect = (mode: SessionPermissionModeChoice) => {
    if (props.busy) return;
    if (mode === "full-access" && !fullAccessActive) {
      if (!policy.allowed) return;
      confirmationArmedRef.current = true;
      setConfirmOpen(true);
      setOpen(false);
      return;
    }
    if (mode === "request-approval" && props.requestedMode === "request-approval") {
      setOpen(false);
      return;
    }
    if (mode === "request-approval") props.onSelectRequestApproval();
    setOpen(false);
  };

  return (
    <div className="flex items-center">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={open}
              title={props.disabledReason ?? t("session.permission_mode_title")}
              disabled={Boolean(props.disabledReason)}
              className={cn(
                "flex h-9 max-h-9 items-center gap-1 rounded-md px-1.5 text-[12px] font-medium text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12",
                open && "bg-gray-3 text-gray-12",
                props.disabledReason && "cursor-not-allowed opacity-50",
              )}
            >
              <span className={current.iconClass}><current.icon size={13} /></span>
              <span className="truncate max-w-32">{current.label}</span>
              <ChevronsUpDown size={12} />
            </button>
          }
        />
        <PopoverContent
          side="top"
          align="start"
          sideOffset={8}
          className="w-[min(360px,calc(100vw-2rem))] max-h-(--available-height) overflow-y-auto p-2 gap-1"
        >
          <div role="menu" className="flex flex-col gap-1">
            <button
              type="button"
              role="menuitemradio"
              aria-checked={props.requestedMode !== "full-access"}
              onClick={() => handleSelect("request-approval")}
              className="flex w-full gap-2 rounded-xl p-3 text-left transition-colors hover:bg-dls-hover aria-checked:bg-dls-hover"
            >
              <span className="w-4 shrink-0 pt-0.5">
                {props.requestedMode !== "full-access" ? <Check size={14} /> : null}
              </span>
              <span className="shrink-0 pt-0.5"><ShieldCheck size={16} /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold">{t("session.permission_mode_request_approval")}</span>
                <span className="mt-1 block text-xs leading-5 text-dls-secondary">
                  {t("session.permission_mode_request_approval_desc")}
                </span>
              </span>
            </button>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={props.requestedMode === "full-access"}
              disabled={!policy.allowed || props.busy}
              onClick={() => handleSelect("full-access")}
              className="flex w-full gap-2 rounded-xl p-3 text-left transition-colors hover:bg-dls-hover aria-checked:bg-dls-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="w-4 shrink-0 pt-0.5">
                {props.requestedMode === "full-access" ? <Check size={14} /> : null}
              </span>
              <span className="shrink-0 pt-0.5"><TriangleAlert size={16} className="text-orange-9" /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold">{t("session.permission_mode_full_access")}</span>
                <span className="mt-1 block text-xs leading-5 text-dls-secondary">
                  {policy.allowed
                    ? t("session.permission_mode_full_access_desc")
                    : t("session.permission_mode_policy_blocked")}
                </span>
              </span>
            </button>
          </div>
          {props.grants.length > 0 ? (
            <div className="mt-2 border-t border-dls-border px-3 pb-1 pt-2">
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-dls-secondary">
                {t("session.permission_mode_session_grants", undefined, { count: props.grants.length })}
              </div>
              <div className="mt-1 text-xs leading-5 text-dls-secondary">
                {t("session.permission_mode_grants_hint")}
              </div>
            </div>
          ) : null}
          {runningHint ? (
            <div className="mt-2 border-t border-dls-border px-3 pb-1 pt-2 text-xs leading-5 text-dls-secondary">
              {runningHint}
            </div>
          ) : null}
        </PopoverContent>
      </Popover>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <TriangleAlert size={18} className="text-orange-9" />
              {t("session.permission_mode_confirm_title")}
            </DialogTitle>
            <DialogDescription>{t("session.permission_mode_confirm_body")}</DialogDescription>
          </DialogHeader>
          <ul className="list-disc space-y-1.5 pl-5 text-[13px] leading-5 text-dls-secondary">
            <li>{t("session.permission_mode_confirm_bullet_files")}</li>
            <li>{t("session.permission_mode_confirm_bullet_shell")}</li>
            <li>{t("session.permission_mode_confirm_bullet_network")}</li>
            <li>{t("session.permission_mode_confirm_bullet_descendants")}</li>
            <li>{t("session.permission_mode_confirm_bullet_boundaries")}</li>
          </ul>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={props.busy}
              onClick={() => {
                setConfirmOpen(false);
                props.onSelectFullAccess();
              }}
            >
              {t("session.permission_mode_confirm_accept")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
