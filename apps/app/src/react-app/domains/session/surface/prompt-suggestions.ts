import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { denCredentialFingerprint as consistencyFingerprint, readDenBootstrapConfig, resolveDenBaseUrls, STORAGE_BASE_URL } from "@/app/lib/den";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import { denSessionUpdatedEvent, denSettingsChangedEvent } from "@/app/lib/den-session-events";
import type { JuggleWorkServerClient } from "@/app/lib/jugglework-server";
import type { ModelRef } from "@/app/types";
import { getComposerQueuedDrafts, useComposerStateStore } from "./composer-state-store";
import { promptSuggestionPending, promptSuggestionScope, promptSuggestionsStore, type PromptSuggestionObservation } from "./prompt-suggestions-store";
import { isSessionSubmissionPreparing } from "../sync/submission-guard";

export { promptSuggestionScope } from "./prompt-suggestions-store";

export function promptSuggestionComposerEmpty(sessionId: string) {
  const state = useComposerStateStore.getState();
  const composer = state.sessions[sessionId];
  return !getComposerQueuedDrafts(state, sessionId).length && (!composer || (
    composer.draft.length === 0 && !composer.attachments.length && !Object.keys(composer.mentions).length &&
    !composer.pasteParts.length && !composer.capabilities.length && !composer.officeGroups.length && !composer.officeSend
  ));
}

export function readPromptSuggestionIdentity() {
  try {
    const storage = typeof window === "undefined" ? undefined : window.localStorage;
    const baseUrl = resolveDenBaseUrls(isDesktopRuntime() ? readDenBootstrapConfig().baseUrl :
      storage?.getItem(STORAGE_BASE_URL) ?? readDenBootstrapConfig().baseUrl).baseUrl;
    return JSON.stringify([baseUrl, storage?.getItem("jugglework.den.activeOrgId")?.trim() || null,
      storage?.getItem("jugglework.den.userId")?.trim() || null]);
  } catch { return "identity-unavailable"; }
}

function subscribeIdentity(listener: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(denSettingsChangedEvent, listener);
  window.addEventListener(denSessionUpdatedEvent, listener);
  return () => {
    window.removeEventListener(denSettingsChangedEvent, listener);
    window.removeEventListener(denSessionUpdatedEvent, listener);
  };
}

export function usePromptSuggestionIdentity() {
  return useSyncExternalStore(subscribeIdentity, readPromptSuggestionIdentity, () => "identity-unavailable");
}

/** Non-security consistency digest; never persist the confirmed policy body. */
export function promptSuggestionPolicyKey(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical) :
    item && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonical(child)])) : item;
  return `policy-fnv1a32:${consistencyFingerprint(JSON.stringify(canonical(value)) ?? "null")}`;
}

type Input = {
  client: JuggleWorkServerClient;
  workspaceId: string;
  sessionId: string;
  model: ModelRef;
  enabled: boolean;
  active: boolean;
  loaded: boolean;
  /** Identity captured by the request that produced this history; null means unverified. */
  historyIdentity?: string | null;
  turnKey: string;
  turnCreatedAt?: number;
  userCreatedAtBaseline?: number;
  completed: boolean;
  running: boolean;
  blocked: boolean;
  empty: boolean;
  ready: boolean;
  policyKey: string | null;
};

export function usePromptSuggestions(input: Input) {
  const owner = useRef({}).current;
  const [pageVisible, setPageVisible] = useState(() => typeof document !== "undefined" && document.visibilityState === "visible");
  const account = usePromptSuggestionIdentity();
  // Consumers without identity-bound snapshots must observe a real loading
  // cycle under the new account. Rerenders/readiness are not ownership proof.
  const historyOwner = useRef({ identity: account, loadingIdentity: input.loaded ? null as string | null : account });
  if (!input.loaded) historyOwner.current.loadingIdentity = account;
  else if (historyOwner.current.loadingIdentity === account) {
    historyOwner.current.identity = account;
    historyOwner.current.loadingIdentity = null;
  }
  const historyCurrent = input.loaded && (input.historyIdentity === undefined ? historyOwner.current.identity === account : input.historyIdentity === account);
  const liveHistoryCurrent = useRef(historyCurrent);
  liveHistoryCurrent.current = historyCurrent;
  const [hidden, setHidden] = useState<string | null>(null);
  const scope = promptSuggestionScope(input.client.baseUrl, input.workspaceId, input.sessionId, account);
  const viewKey = JSON.stringify([scope, input.turnKey]);
  const composerEmpty = useSyncExternalStore(useComposerStateStore.subscribe,
    () => promptSuggestionComposerEmpty(input.sessionId), () => false);
  const context = JSON.stringify([input.model.providerID, input.model.modelID, input.policyKey]);
  const capabilities = useQuery({
    queryKey: ["prompt-suggestions-capabilities", input.client.baseUrl, account],
    queryFn: () => input.client.capabilities(),
    enabled: input.enabled && input.active,
    staleTime: Infinity, retry: false, refetchOnMount: "always",
  });
  const latest = useRef(input);
  latest.current = input;
  const liveContext = useRef(context);
  liveContext.current = context;
  const active = input.active && pageVisible;
  const ready = input.ready && input.policyKey !== null && capabilities.isSuccess && capabilities.data.sessions?.promptSuggestions === true && input.client.supportsPromptSuggestions();
  const readiness = useRef(ready);
  readiness.current = ready;
  const current = () => {
    const now = latest.current;
    return liveContext.current === context && now.turnKey === input.turnKey && now.client === input.client &&
      now.workspaceId === input.workspaceId && now.sessionId === input.sessionId && readiness.current &&
      liveHistoryCurrent.current && account !== "identity-unavailable" && now.enabled && now.active && now.ready && now.completed && !now.blocked && !now.running &&
      readPromptSuggestionIdentity() === account && document.visibilityState === "visible" &&
      !getComposerQueuedDrafts(useComposerStateStore.getState(), now.sessionId).length &&
      !isSessionSubmissionPreparing(now.workspaceId, now.sessionId);
  };
  const observation: PromptSuggestionObservation = {
    scope, context, loaded: historyCurrent, turnKey: input.turnKey, turnCreatedAt: input.turnCreatedAt,
    userCreatedAtBaseline: input.userCreatedAtBaseline, enabled: input.enabled, active,
    completed: input.completed, running: input.running, blocked: input.blocked,
    empty: input.empty, ready,
    current,
    canRequest: () => current() && latest.current.empty && promptSuggestionComposerEmpty(input.sessionId),
    request: (signal) => input.client.getPromptSuggestion(input.workspaceId, input.sessionId, { turnKey: input.turnKey, model: input.model }, { signal }),
  };
  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") return;
    const visibility = () => {
      if (document.visibilityState !== "visible") promptSuggestionsStore.finish(scope);
      else setHidden(null);
      setPageVisible(document.visibilityState === "visible");
    };
    const accountChanged = () => { if (readPromptSuggestionIdentity() !== account) promptSuggestionsStore.finish(scope); };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener(denSettingsChangedEvent, accountChanged);
    window.addEventListener(denSessionUpdatedEvent, accountChanged);
    const unsubscribe = useComposerStateStore.subscribe((state, previous) => {
      const queue = getComposerQueuedDrafts(state, input.sessionId);
      if (queue.length && queue !== getComposerQueuedDrafts(previous, input.sessionId)) promptSuggestionsStore.finish(scope);
      if (state.sessions[input.sessionId] !== previous.sessions[input.sessionId] && promptSuggestionComposerEmpty(input.sessionId)) setHidden(null);
    });
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener(denSettingsChangedEvent, accountChanged);
      window.removeEventListener(denSessionUpdatedEvent, accountChanged);
      unsubscribe();
    };
  }, [scope, account, input.sessionId]);
  useEffect(() => { setHidden(null); }, [viewKey, active]);
  useEffect(() => { if (input.empty && composerEmpty) setHidden(null); }, [input.empty, composerEmpty]);
  useEffect(() => () => promptSuggestionsStore.detach(scope, owner), [scope, owner, input.client]);
  useEffect(() => { promptSuggestionsStore.observe(observation, owner); });
  const snapshot = useSyncExternalStore(promptSuggestionsStore.subscribe,
    () => promptSuggestionsStore.snapshot(scope, input.turnKey, context), () => null);
  const dismiss = useCallback(() => { setHidden(viewKey); promptSuggestionsStore.finish(scope); }, [scope, viewKey]);
  // The editor writes the draft; acceptance only hides this view's placeholder.
  const accept = useCallback(() => { setHidden(viewKey); }, [viewKey]);
  const available = historyCurrent && input.enabled && input.empty && composerEmpty && hidden !== viewKey && active && ready && current();
  return {
    suggestion: available && typeof snapshot === "string" ? snapshot : null,
    pending: available && snapshot === promptSuggestionPending,
    dismiss, accept,
  };
}
