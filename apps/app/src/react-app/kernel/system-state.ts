import { useCallback, useMemo, useRef, useState } from "react";

import type {
  ReloadReason,
  ReloadTrigger,
  ResetJuggleWorkMode,
} from "../../app/types";
import { relaunchDesktopApp, resetJuggleWorkState } from "../../app/lib/desktop";
import { isEngineReloadDeferredError } from "../../app/lib/jugglework-server";
import {
  addOpencodeCacheHint,
  isDesktopRuntime,
  safeStringify,
} from "../../app/utils";
import { t } from "../../i18n";

export type ReloadState = {
  /** Pending for the current workspace: an unscoped mark, or a mark scoped to
   *  `currentWorkspaceId`. Drives auto-reload and the pending notices. */
  reloadPending: boolean;
  /** Workspaces with a scoped pending reload that no reload of that same
   *  workspace has applied yet. Another workspace's reload never clears them. */
  pendingWorkspaceIds: string[];
  reloadReasons: ReloadReason[];
  reloadLastTriggeredAt: number | null;
  reloadTrigger: ReloadTrigger | null;
  reloadBusy: boolean;
  reloadError: string | null;
};

export type ResetState = {
  resetModalOpen: boolean;
  resetModalMode: ResetJuggleWorkMode;
  resetModalText: string;
  resetModalBusy: boolean;
};

export type ReloadScope = { workspaceId?: string | null };

export type SystemStateControls = {
  reload: ReloadState;
  reloadCopy: { title: string; body: string };
  markReloadRequired: (reason: ReloadReason, trigger?: ReloadTrigger, scope?: ReloadScope) => void;
  /** Without a workspace id clears every pending reload (previous behaviour);
   *  with one, clears unscoped pending work plus that workspace's entry only. */
  clearReloadRequired: (workspaceId?: string | null) => void;
  reloadWorkspaceEngine: () => Promise<void>;
  canReloadWorkspaceEngine: boolean;
  reset: ResetState;
  openResetModal: (mode: ResetJuggleWorkMode) => void;
  closeResetModal: () => void;
  setResetModalText: (value: string) => void;
  confirmReset: () => Promise<void>;
  setError: (message: string | null) => void;
};

function clearJuggleWorkLocalStorage(mode: ResetJuggleWorkMode) {
  if (typeof window === "undefined") return;
  try {
    if (mode === "all") {
      window.localStorage.clear();
      return;
    }
    const keys = Object.keys(window.localStorage);
    for (const key of keys) {
      if (/jugglework/.test(key)) window.localStorage.removeItem(key);
    }
    window.localStorage.removeItem("jugglework_mode_pref");
  } catch {
    // ignore
  }
}

type UseSystemStateOptions = {
  hasActiveRuns: () => boolean;
  reloadWorkspaceEngine?: () => Promise<boolean>;
  canReloadWorkspaceEngine?: () => boolean;
  onReloadComplete?: () => void | Promise<void>;
  setError: (message: string | null) => void;
  /** Workspace whose reload controls are registered; a reload applies to it. */
  currentWorkspaceId?: string | null;
};

export function useSystemState(
  options: UseSystemStateOptions,
): SystemStateControls {
  // Unscoped pending work (every pre-existing caller). Any successful reload
  // clears it, exactly as before.
  const [unscopedReloadPending, setReloadPending] = useState(false);
  const [pendingWorkspaceIds, setPendingWorkspaceIdsState] = useState<string[]>([]);
  // Mirror for synchronous reads inside callbacks (clear/deferred paths).
  const pendingWorkspaceIdsRef = useRef<string[]>([]);
  const setPendingWorkspaceIds = useCallback((next: string[]) => {
    pendingWorkspaceIdsRef.current = next;
    setPendingWorkspaceIdsState(next);
  }, []);
  const currentWorkspaceId = options.currentWorkspaceId?.trim() || null;
  const reloadPending =
    unscopedReloadPending ||
    (currentWorkspaceId !== null && pendingWorkspaceIds.includes(currentWorkspaceId));
  const [reloadReasons, setReloadReasons] = useState<ReloadReason[]>([]);
  const [reloadLastTriggeredAt, setReloadLastTriggeredAt] = useState<
    number | null
  >(null);
  const [reloadTrigger, setReloadTrigger] = useState<ReloadTrigger | null>(null);
  const [reloadBusy, setReloadBusy] = useState(false);
  const [reloadError, setReloadError] = useState<string | null>(null);

  const [resetModalOpen, setResetModalOpen] = useState(false);
  const [resetModalMode, setResetModalMode] =
    useState<ResetJuggleWorkMode>("onboarding");
  const [resetModalText, setResetModalText] = useState("");
  const [resetModalBusy, setResetModalBusy] = useState(false);

  const markReloadRequired = useCallback(
    (reason: ReloadReason, trigger?: ReloadTrigger, scope?: ReloadScope) => {
      const workspaceId = scope?.workspaceId?.trim() || null;
      if (workspaceId) {
        const current = pendingWorkspaceIdsRef.current;
        if (!current.includes(workspaceId)) setPendingWorkspaceIds([...current, workspaceId]);
      } else {
        setReloadPending(true);
      }
      setReloadLastTriggeredAt(Date.now());
      setReloadReasons((current) =>
        current.includes(reason) ? current : [...current, reason],
      );
      setReloadTrigger(
        trigger ??
          ({
            type:
              reason === "plugins"
                ? "plugin"
                : reason === "skills"
                  ? "skill"
                  : reason === "agents"
                    ? "agent"
                    : reason === "commands"
                      ? "command"
                      : reason,
          } as ReloadTrigger),
      );
    },
    [setPendingWorkspaceIds],
  );

  const clearReloadRequired = useCallback((workspaceId?: string | null) => {
    const scopedId = workspaceId?.trim() || null;
    setReloadPending(false);
    setReloadError(null);
    if (!scopedId) {
      setPendingWorkspaceIds([]);
      setReloadReasons([]);
      setReloadTrigger(null);
      return;
    }
    // A reload only applies to the workspace it targeted. Other workspaces
    // keep their pending entry (and the reasons describing it) until they
    // are selected again and reloaded themselves.
    const current = pendingWorkspaceIdsRef.current;
    const next = current.filter((id) => id !== scopedId);
    if (next.length !== current.length) setPendingWorkspaceIds(next);
    if (next.length === 0) {
      setReloadReasons([]);
      setReloadTrigger(null);
    }
  }, [setPendingWorkspaceIds]);

  const reloadCopy = useMemo(() => {
    const title = t("system.reload_required");
    const bodyKey =
      reloadReasons.length === 1 && reloadReasons[0] === "plugins"
        ? "system.reload_body_plugins"
        : reloadReasons.length === 1 && reloadReasons[0] === "skills"
          ? "system.reload_body_skills"
          : reloadReasons.length === 1 && reloadReasons[0] === "agents"
            ? "system.reload_body_agents"
            : reloadReasons.length === 1 && reloadReasons[0] === "commands"
              ? "system.reload_body_commands"
              : reloadReasons.length === 1 && reloadReasons[0] === "config"
                ? "system.reload_body_config"
                : reloadReasons.length === 1 && reloadReasons[0] === "mcp"
                  ? "system.reload_body_mcp"
                  : reloadReasons.length > 0
                    ? "system.reload_body_mixed"
                    : "system.reload_body_default";
    return { title, body: t(bodyKey) };
  }, [reloadReasons]);

  const canReloadWorkspaceEngine =
    !reloadBusy && options.canReloadWorkspaceEngine?.() !== false;

  const reloadWorkspaceEngine = useCallback(async () => {
    if (reloadBusy) return;
    if (options.canReloadWorkspaceEngine?.() === false) {
      setReloadError(t("system.reload_unavailable"));
      return;
    }
    // Captured before awaiting: the selection may change mid-reload, and only
    // the workspace this request targeted is applied by it.
    const reloadedWorkspaceId = options.currentWorkspaceId?.trim() || null;
    setReloadBusy(true);
    setReloadError(null);
    options.setError(null);
    try {
      const ok = options.reloadWorkspaceEngine
        ? await options.reloadWorkspaceEngine()
        : false;
      if (ok === false) {
        setReloadError(t("system.reload_failed"));
        return;
      }
      await options.onReloadComplete?.();
      clearReloadRequired(reloadedWorkspaceId);
    } catch (error) {
      if (isEngineReloadDeferredError(error)) {
        // The server is the authoritative activity gate. A renderer can see
        // an idle snapshot just before the server observes the run terminal,
        // so keep this as pending work instead of poisoning task readiness
        // with a permanent reload error. The reload coordinator will retry
        // after activity settles (or after its bounded cooldown in a race).
        // A scoped entry for this workspace already keeps it pending; only
        // unscoped work needs the unscoped flag re-raised.
        if (!(reloadedWorkspaceId && pendingWorkspaceIdsRef.current.includes(reloadedWorkspaceId))) {
          setReloadPending(true);
        }
        setReloadLastTriggeredAt(Date.now());
        setReloadError(null);
        return;
      }
      const message = error instanceof Error ? error.message : safeStringify(error);
      setReloadError(message || t("system.reload_failed"));
    } finally {
      setReloadBusy(false);
    }
  }, [clearReloadRequired, options, reloadBusy]);

  const openResetModal = useCallback(
    (mode: ResetJuggleWorkMode) => {
      if (options.hasActiveRuns()) {
        options.setError(t("system.stop_active_runs_before_reset"));
        return;
      }
      options.setError(null);
      setResetModalMode(mode);
      setResetModalText("");
      setResetModalOpen(true);
    },
    [options],
  );

  const closeResetModal = useCallback(() => {
    if (resetModalBusy) return;
    setResetModalOpen(false);
  }, [resetModalBusy]);

  const confirmReset = useCallback(async () => {
    if (resetModalBusy) return;
    if (options.hasActiveRuns()) {
      options.setError(t("system.stop_active_runs_before_reset"));
      return;
    }
    if (resetModalText.trim().toUpperCase() !== "RESET") return;

    setResetModalBusy(true);
    options.setError(null);

    try {
      if (isDesktopRuntime()) {
        await resetJuggleWorkState(resetModalMode);
      }
      clearJuggleWorkLocalStorage(resetModalMode);
      if (isDesktopRuntime()) {
        await relaunchDesktopApp();
      } else {
        window.location.reload();
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : safeStringify(error);
      options.setError(addOpencodeCacheHint(message));
      setResetModalBusy(false);
    }
  }, [options, resetModalBusy, resetModalMode, resetModalText]);

  return useMemo<SystemStateControls>(
    () => ({
      reload: {
        reloadPending,
        pendingWorkspaceIds,
        reloadReasons,
        reloadLastTriggeredAt,
        reloadTrigger,
        reloadBusy,
        reloadError,
      },
      reloadCopy,
      markReloadRequired,
      clearReloadRequired,
      reloadWorkspaceEngine,
      canReloadWorkspaceEngine,
      reset: {
        resetModalOpen,
        resetModalMode,
        resetModalText,
        resetModalBusy,
      },
      openResetModal,
      closeResetModal,
      setResetModalText,
      confirmReset,
      setError: options.setError,
    }),
    [
      clearReloadRequired,
      closeResetModal,
      confirmReset,
      markReloadRequired,
      openResetModal,
      options.setError,
      reloadCopy,
      reloadBusy,
      reloadWorkspaceEngine,
      canReloadWorkspaceEngine,
      reloadError,
      reloadLastTriggeredAt,
      reloadPending,
      pendingWorkspaceIds,
      reloadReasons,
      reloadTrigger,
      resetModalBusy,
      resetModalMode,
      resetModalOpen,
      resetModalText,
    ],
  );
}
