/** @jsxImportSource react */
import {
  CheckCircle2,
  ChevronRight,
  Loader2,
  Plus,
  Search,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { openDesktopUrl } from "@/app/lib/desktop";
import { isDesktopRuntime } from "@/app/utils";
import { compareProviders } from "@/app/utils/providers";
import { isProviderHiddenFromConnectUi } from "@/app/cloud/desktop-app-restrictions";
import { Button } from "@/components/ui/button";
import { ProviderIcon } from "../../../design-system/provider-icon";
import { TextInput } from "../../../design-system/text-input";
import {
  normalizeCustomProviderId,
  normalizeCustomProviderInput,
  parseCustomProviderModels,
  validateCustomProviderInput,
  type CustomProviderInput,
} from "./custom-provider-config";
import type {
  ProviderAuthMethod,
  ProviderAuthProvider,
  ProviderOAuthStartResult,
} from "./store";

type ProviderAuthEntry = {
  id: string;
  name: string;
  methods: ProviderAuthMethod[];
  connected: boolean;
  env: string[];
};

type ProviderOAuthSession = ProviderOAuthStartResult & {
  providerId: string;
  methodLabel: string;
};

type CustomProviderForm = {
  name: string;
  providerId: string;
  baseUrl: string;
  apiKey: string;
  models: string;
  contextLimit: string;
  outputLimit: string;
};

const EMPTY_CUSTOM_FORM: CustomProviderForm = {
  name: "",
  providerId: "",
  baseUrl: "",
  apiKey: "",
  models: "",
  contextLimit: "",
  outputLimit: "",
};

const customProviderFormFromInput = (input: CustomProviderInput): CustomProviderForm => ({
  name: input.name,
  providerId: input.providerId,
  baseUrl: input.baseUrl,
  apiKey: "",
  models: input.models
    .map((model) => model.name === model.id ? model.id : `${model.id} = ${model.name}`)
    .join("\n"),
  contextLimit: input.contextLimit ? String(input.contextLimit) : "",
  outputLimit: input.outputLimit ? String(input.outputLimit) : "",
});

/**
 * Words that should surface the custom-provider card while filtering. The
 * localized title and description are folded in so the card is findable by
 * whatever the user actually sees.
 */
const customEntryKeywords = () =>
  `custom provider openai compatible relay proxy gateway base url endpoint 自定义 中转 ${t(
    "providers.custom_title",
  )} ${t("providers.custom_card_desc")}`.toLowerCase();

const readOptionalCount = (value: string): number | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed.replace(/[_,\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

const PROVIDER_LABELS: Record<string, string> = {
  opencode: "OpenCode Zen",
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  openrouter: "OpenRouter",
  jugglerouter: "JuggleRouter",
};

export type CustomProviderConnectInput = CustomProviderInput & { apiKey: string };

export type ProviderAuthModalProps = {
  open: boolean;
  loading: boolean;
  submitting: boolean;
  error: string | null;
  preferredProviderId?: string | null;
  workerType?: "local" | "remote";
  providers: ProviderAuthProvider[];
  connectedProviderIds: string[];
  authMethods: Record<string, ProviderAuthMethod[]>;
  onSelect: (providerId: string, methodIndex?: number) => Promise<ProviderOAuthStartResult>;
  onSubmitApiKey: (providerId: string, apiKey: string) => Promise<string | void>;
  onConnectCloudProvider: (cloudProviderId: string) => Promise<string | void>;
  /**
   * Declare an OpenAI-compatible endpoint the user brings themselves (relay
   * platform, gateway, self-hosted proxy). Omitted callers simply don't get the
   * "Custom provider" entry.
   */
  onConnectCustomProvider?: (input: CustomProviderConnectInput) => Promise<string | void>;
  /** 正在查看或编辑的本地模型组；为空时保持新增流程。 */
  customProviderDraft?: CustomProviderInput | null;
  onSubmitOAuth: (
    providerId: string,
    methodIndex: number,
    code?: string,
  ) => Promise<{ connected: boolean; pending?: boolean; message?: string }>;
  onRefreshProviders?: () => Promise<unknown>;
  onClose: () => void;
};

export default function ProviderAuthModal(props: ProviderAuthModalProps) {
  const workerType = props.workerType === "remote" ? "remote" : "local";
  const isRemoteWorker = workerType === "remote";

  const [view, setView] = useState<
    "list" | "method" | "api" | "cloud" | "custom" | "oauth-code" | "oauth-auto"
  >("list");
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [selectedCloudMethod, setSelectedCloudMethod] = useState<ProviderAuthMethod | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [oauthCodeInput, setOauthCodeInput] = useState("");
  const [oauthSession, setOauthSession] = useState<ProviderOAuthSession | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeEntryIndex, setActiveEntryIndex] = useState(0);
  const [localError, setLocalError] = useState<string | null>(null);
  const [pollingBusy, setPollingBusy] = useState(false);
  const [oauthAutoBusy, setOauthAutoBusy] = useState(false);
  const [oauthCodeCopied, setOauthCodeCopied] = useState(false);
  const [oauthBrowserOpened, setOauthBrowserOpened] = useState(false);
  const [customForm, setCustomForm] = useState(EMPTY_CUSTOM_FORM);
  const [customIdEdited, setCustomIdEdited] = useState(false);
  const [customProviderEditing, setCustomProviderEditing] = useState(false);

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const providerPollRef = useRef<number | null>(null);
  const oauthAutoPollRef = useRef<number | null>(null);
  const oauthCodeCopiedResetRef = useRef<number | null>(null);
  const autoOpenedPreferredProviderIdRef = useRef<string | null>(null);

  const formatProviderName = (id: string, fallback?: string) => {
    const named = fallback?.trim();
    if (named) return named;

    const normalized = id.trim();
    const mapped = PROVIDER_LABELS[normalized.toLowerCase()];
    if (mapped) return mapped;

    const cleaned = normalized.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
    if (!cleaned) return id;

    return cleaned
      .split(" ")
      .flatMap((word) => {
        if (!word) return [];
        if (/\d/.test(word) || word.length <= 3) {
          return [word.toUpperCase()];
        }
        const lower = word.toLowerCase();
        return [lower.charAt(0).toUpperCase() + lower.slice(1)];
      })
      .join(" ");
  };

  const isOpenAiHeadlessMethod = (method: ProviderAuthMethod) => {
    const label = method.label.toLowerCase();
    return method.type === "oauth" && (label.includes("headless") || label.includes("device"));
  };

  const isOpenAiProvider = (id: string, fallbackName?: string) => {
    const normalizedId = id.trim().toLowerCase();
    const normalizedName = fallbackName?.trim().toLowerCase() ?? "";
    return normalizedId === "openai" || normalizedName === "openai";
  };

  const isAnthropicProvider = (id: string, fallbackName?: string) => {
    const normalizedId = id.trim().toLowerCase();
    const normalizedName = fallbackName?.trim().toLowerCase() ?? "";
    return normalizedId === "anthropic" || normalizedName === "anthropic";
  };

  const isClaudeProMaxMethod = (method: ProviderAuthMethod) => {
    const label = method.label.toLowerCase();
    return method.type === "oauth" && (label.includes("pro/max") || label.includes("create an api key"));
  };

  const entries = useMemo<ProviderAuthEntry[]>(() => {
    const methods = props.authMethods ?? {};
    const connected = new Set(props.connectedProviderIds ?? []);
    const providers = props.providers ?? [];

    const providersById = new Map(providers.map((provider) => [provider.id, provider]));
    const nextEntries = Object.keys(methods)
      .flatMap((id) => {
        const provider = providersById.get(id);
        const entryMethods = (methods[id] ?? []).filter((method) => {
          if (isAnthropicProvider(id, provider?.name) && isClaudeProMaxMethod(method)) {
            return false;
          }
          if (!isOpenAiProvider(id, provider?.name)) return true;
          if (method.type !== "oauth") return true;
          if (isRemoteWorker) return isOpenAiHeadlessMethod(method);
          return !isOpenAiHeadlessMethod(method);
        });
        if (entryMethods.length === 0) return [];
        return [{
          id,
          name: formatProviderName(id, provider?.name),
          methods: entryMethods,
          connected: connected.has(id),
          env: Array.isArray(provider?.env) ? provider.env : [],
        } satisfies ProviderAuthEntry];
      })
      .sort(compareProviders);

    // Belt and braces: the routes already strip these before passing
    // `authMethods` in, but the modal owns what it renders.
    return nextEntries.filter((entry) => !isProviderHiddenFromConnectUi(entry.id));
  }, [isRemoteWorker, props.authMethods, props.connectedProviderIds, props.providers]);

  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.id === selectedProviderId) ?? null,
    [entries, selectedProviderId],
  );

  // The custom-provider form is the one view that has no selected entry behind
  // it — everything else falls back to the list when the selection is gone.
  const resolvedView = view === "custom" ? "custom" : selectedEntry ? view : "list";
  const errorMessage = localError ?? props.error;

  const customEntryEnabled = Boolean(props.onConnectCustomProvider);
  const customModels = useMemo(
    () => parseCustomProviderModels(customForm.models),
    [customForm.models],
  );
  const hasCustomProviderDraft = Boolean(props.customProviderDraft);
  const isViewingCustomProvider = hasCustomProviderDraft && !customProviderEditing;
  const isEditingCustomProvider = hasCustomProviderDraft && customProviderEditing;
  const customProviderId = customIdEdited
    ? customForm.providerId
    : normalizeCustomProviderId(customForm.name);
  const customProviderIdHint = hasCustomProviderDraft
    ? t("providers.custom_id_edit_hint")
    : normalizeCustomProviderId(customProviderId) !== customProviderId.trim() &&
        customProviderId.trim()
      ? t("providers.custom_id_normalized_hint", {
          id: normalizeCustomProviderId(customProviderId),
        })
      : t("providers.custom_id_hint");

  const showCustomEntry = useMemo(() => {
    if (!customEntryEnabled) return false;
    const query = searchQuery.trim().toLowerCase();
    if (!query) return true;
    return customEntryKeywords().includes(query);
  }, [customEntryEnabled, searchQuery]);

  const filteredEntries = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return entries;
    return entries.filter((entry) => {
      const methodText = entry.methods.map((method) => method.label || (method.type === "oauth" ? "OAuth" : "API key")).join(" ");
      return `${entry.name} ${entry.id} ${methodText}`.toLowerCase().includes(query);
    });
  }, [entries, searchQuery]);

  const oauthInstructions = oauthSession?.authorization.instructions?.trim() ?? "";
  const isOpenAiHeadlessSession = Boolean(
    oauthSession && oauthSession.providerId === "openai" && oauthSession.methodLabel.toLowerCase().includes("headless"),
  );
  const shouldStartOauthAutoPolling =
    props.open &&
    resolvedView === "oauth-auto" &&
    oauthSession &&
    (!isOpenAiHeadlessSession || oauthBrowserOpened);

  const oauthDisplayCode = useMemo(() => {
    if (!oauthInstructions) return "";
    const matched = oauthInstructions.match(/[A-Z0-9]{4}-[A-Z0-9]{4,5}/)?.[0];
    if (matched) return matched;
    if (oauthInstructions.includes(":")) {
      return oauthInstructions.split(":").slice(1).join(":").trim();
    }
    return oauthInstructions;
  }, [oauthInstructions]);

  const methodLabel = (method: ProviderAuthMethod) =>
    method.label || (method.type === "oauth" ? "OAuth" : "API key");

  const actionDisabled = props.loading || props.submitting;

  const resetState = () => {
    if (oauthCodeCopiedResetRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(oauthCodeCopiedResetRef.current);
      oauthCodeCopiedResetRef.current = null;
    }
    setView("list");
    setSelectedProviderId(null);
    setSelectedCloudMethod(null);
    setApiKeyInput("");
    setOauthCodeInput("");
    setOauthSession(null);
    setSearchQuery("");
    setActiveEntryIndex(0);
    setLocalError(null);
    setOauthCodeCopied(false);
    setOauthBrowserOpened(false);
    setCustomForm(EMPTY_CUSTOM_FORM);
    setCustomIdEdited(false);
    setCustomProviderEditing(false);
  };

  const stopProviderPolling = () => {
    if (providerPollRef.current !== null) {
      window.clearInterval(providerPollRef.current);
      providerPollRef.current = null;
    }
  };

  const stopOauthAutoPolling = () => {
    if (oauthAutoPollRef.current !== null) {
      window.clearInterval(oauthAutoPollRef.current);
      oauthAutoPollRef.current = null;
    }
  };

  const handleClose = () => {
    void props.onRefreshProviders?.();
    stopOauthAutoPolling();
    stopProviderPolling();
    resetState();
    props.onClose();
  };

  useEffect(() => {
    if (!props.open) {
      autoOpenedPreferredProviderIdRef.current = null;
      resetState();
    }
  }, [props.open]);

  useEffect(() => {
    if (!props.open || !props.customProviderDraft) return;
    setCustomForm(customProviderFormFromInput(props.customProviderDraft));
    setCustomIdEdited(true);
    setCustomProviderEditing(false);
    setLocalError(null);
    setView("custom");
  }, [props.customProviderDraft, props.open]);

  useEffect(() => {
    if (!props.open || resolvedView !== "list") return;
    const total = filteredEntries.length;
    if (total <= 0) {
      setActiveEntryIndex(0);
      return;
    }
    setActiveEntryIndex((current) => Math.max(0, Math.min(current, total - 1)));
  }, [filteredEntries.length, props.open, resolvedView]);

  useEffect(() => {
    if (!props.open || resolvedView !== "list") return;
    queueMicrotask(() => searchInputRef.current?.focus());
  }, [props.open, resolvedView]);

  useEffect(() => {
    if (!props.open || props.loading || resolvedView !== "list") return;

    const preferredId = props.preferredProviderId?.trim().toLowerCase() ?? "";
    if (!preferredId || autoOpenedPreferredProviderIdRef.current === preferredId) return;

    const entry = entries.find((item) => item.id.trim().toLowerCase() === preferredId);
    if (!entry) return;

    autoOpenedPreferredProviderIdRef.current = preferredId;
    queueMicrotask(() => {
      handleEntrySelect(entry);
    });
  }, [
    entries,
    props.loading,
    props.open,
    props.preferredProviderId,
    resolvedView,
  ]);

  useEffect(() => {
    return () => {
      stopOauthAutoPolling();
      stopProviderPolling();
      if (oauthCodeCopiedResetRef.current !== null) {
        window.clearTimeout(oauthCodeCopiedResetRef.current);
        oauthCodeCopiedResetRef.current = null;
      }
    };
  }, []);

  const isOauthView = resolvedView === "oauth-code" || resolvedView === "oauth-auto";
  const activeProviderId = oauthSession?.providerId ?? selectedProviderId;
  const isActiveProviderConnected =
    !!activeProviderId && (props.connectedProviderIds ?? []).includes(activeProviderId);

  const pollProviders = async () => {
    const id = activeProviderId;
    if (!id || pollingBusy) return;
    setPollingBusy(true);
    try {
      await props.onRefreshProviders?.();
    } finally {
      setPollingBusy(false);
    }
    if ((props.connectedProviderIds ?? []).includes(id)) {
      handleClose();
    }
  };

  const startProviderPolling = () => {
    if (typeof window === "undefined") return;
    if (providerPollRef.current !== null) return;
    void pollProviders();
    providerPollRef.current = window.setInterval(() => {
      void pollProviders();
    }, 2000);
  };

  useEffect(() => {
    if (!props.open || !isOauthView) {
      stopProviderPolling();
      return;
    }
    if (isActiveProviderConnected) {
      handleClose();
      return;
    }
    startProviderPolling();
  }, [isActiveProviderConnected, isOauthView, props.open]);

  const openOauthUrl = async (url: string) => {
    if (!url) return;
    if (isDesktopRuntime()) {
      await openDesktopUrl(url);
      setOauthBrowserOpened(true);
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
    setOauthBrowserOpened(true);
  };

  const copyOauthDisplayCode = async () => {
    const code = oauthDisplayCode.trim();
    if (!code) return;
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      setLocalError("Clipboard is unavailable in this environment.");
      return;
    }
    await navigator.clipboard.writeText(code);
    setOauthCodeCopied(true);
    if (typeof window === "undefined") return;
    if (oauthCodeCopiedResetRef.current !== null) {
      window.clearTimeout(oauthCodeCopiedResetRef.current);
    }
    oauthCodeCopiedResetRef.current = window.setTimeout(() => {
      setOauthCodeCopied(false);
      oauthCodeCopiedResetRef.current = null;
    }, 2000);
  };

  const submitOauth = async (providerId: string, methodIndex: number, code?: string) => {
    const trimmedCode = code?.trim();
    setLocalError(null);
    try {
      return await props.onSubmitOAuth(providerId, methodIndex, trimmedCode || undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to complete OAuth";
      setLocalError(message);
      throw error instanceof Error ? error : new Error(message);
    }
  };

  const attemptOauthAutoCompletion = async () => {
    const session = oauthSession;
    if (!session || oauthAutoBusy) return;
    setOauthAutoBusy(true);
    try {
      const result = await submitOauth(session.providerId, session.methodIndex);
      if (result?.connected) {
        stopOauthAutoPolling();
      }
    } finally {
      setOauthAutoBusy(false);
    }
  };

  const startOauthAutoPolling = () => {
    if (typeof window === "undefined") return;
    if (oauthAutoPollRef.current !== null) return;
    void attemptOauthAutoCompletion();
    oauthAutoPollRef.current = window.setInterval(() => {
      void attemptOauthAutoCompletion();
    }, 2000);
  };

  useEffect(() => {
    if (!shouldStartOauthAutoPolling) {
      stopOauthAutoPolling();
      return;
    }
    startOauthAutoPolling();
  }, [shouldStartOauthAutoPolling]);

  const startOauth = async (entry: ProviderAuthEntry, methodIndex?: number) => {
    if (actionDisabled) return;
    if (!Number.isInteger(methodIndex) || methodIndex === undefined) {
      setLocalError(`No OAuth flow available for ${entry.name}.`);
      return;
    }
    setLocalError(null);
    setOauthCodeInput("");
    setOauthSession(null);
    setOauthCodeCopied(false);
    setOauthBrowserOpened(false);
    try {
      const started = await props.onSelect(entry.id, methodIndex);
      const selectedMethod = entry.methods.find((method) => method.methodIndex === methodIndex);
      if (!selectedMethod) {
        throw new Error(`Selected auth method is unavailable for ${entry.name}.`);
      }
      const nextSession: ProviderOAuthSession = {
        providerId: entry.id,
        methodIndex: started.methodIndex,
        methodLabel: selectedMethod.label,
        authorization: started.authorization,
      };
      setOauthSession(nextSession);

      if (started.authorization.method === "code") {
        await openOauthUrl(started.authorization.url);
        setView("oauth-code");
        return;
      }

      if (!isOpenAiHeadlessMethod(selectedMethod)) {
        await openOauthUrl(started.authorization.url);
      }

      setView("oauth-auto");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start OAuth";
      setLocalError(message);
    }
  };

  const handleMethodSelect = async (
    method: ProviderAuthMethod,
    entry: ProviderAuthEntry | null = selectedEntry,
  ) => {
    if (!entry || actionDisabled) return;
    setLocalError(null);
    setSelectedCloudMethod(null);

    if (method.type === "oauth") {
      await startOauth(entry, method.methodIndex);
      return;
    }

    if (method.type === "cloud") {
      setSelectedCloudMethod(method);
      setView("cloud");
      return;
    }

    setView("api");
  };

  const handleEntrySelect = (entry: ProviderAuthEntry) => {
    if (actionDisabled) return;
    setLocalError(null);
    setSelectedProviderId(entry.id);

    if (entry.methods.length === 1) {
      void handleMethodSelect(entry.methods[0], entry);
      return;
    }

    if (entry.methods.length > 1) {
      setView("method");
      return;
    }

    setLocalError(`No authentication methods available for ${entry.name}.`);
  };

  const handleApiSubmit = async () => {
    if (!selectedEntry || actionDisabled) return;

    const trimmed = apiKeyInput.trim();
    if (!trimmed) {
      setLocalError("API key is required.");
      return;
    }

    setLocalError(null);
    try {
      await props.onSubmitApiKey(selectedEntry.id, trimmed);
      toast.success(`${selectedEntry.name} connected`, {
        description: "API key saved locally by OpenCode.",
      });
      // Close the modal after a successful save
      props.onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save API key";
      setLocalError(message);
    }
  };

  const openCustomView = () => {
    if (actionDisabled) return;
    setLocalError(null);
    setSelectedProviderId(null);
    setSelectedCloudMethod(null);
    setView("custom");
  };

  const handleCustomSubmit = async () => {
    if (!props.onConnectCustomProvider || actionDisabled) return;

    const input = normalizeCustomProviderInput({
      providerId: customProviderId,
      name: customForm.name,
      baseUrl: customForm.baseUrl,
      models: customModels,
      contextLimit: readOptionalCount(customForm.contextLimit),
      outputLimit: readOptionalCount(customForm.outputLimit),
    });

    const validationError = validateCustomProviderInput(input);
    if (validationError) {
      setLocalError(t(validationError));
      return;
    }

    setLocalError(null);
    try {
      await props.onConnectCustomProvider({ ...input, apiKey: customForm.apiKey });
      const successKey = isEditingCustomProvider
        ? "providers.custom_updated_toast"
        : "providers.custom_connected_toast";
      toast.success(t(successKey, { name: input.name }), {
        description: t("providers.custom_connected_models", { count: input.models.length }),
      });
      props.onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : t("providers.custom_add_failed");
      setLocalError(message);
    }
  };

  const handleCloudSubmit = async () => {
    if (!selectedCloudMethod?.cloudProviderId || actionDisabled) return;

    setLocalError(null);
    try {
      await props.onConnectCloudProvider(selectedCloudMethod.cloudProviderId);
      props.onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to connect organization provider";
      setLocalError(message);
    }
  };

  const handleOauthCodeSubmit = async () => {
    if (!selectedEntry || !oauthSession || actionDisabled) return;

    const trimmed = oauthCodeInput.trim();
    if (!trimmed) {
      setLocalError("Authorization code is required.");
      return;
    }

    await submitOauth(selectedEntry.id, oauthSession.methodIndex, trimmed);
  };

  const handleBack = () => {
    if (resolvedView === "custom" && hasCustomProviderDraft) {
      handleClose();
      return;
    }

    if (resolvedView === "oauth-code" || resolvedView === "oauth-auto") {
      if ((selectedEntry?.methods.length ?? 0) > 1) {
        setView("method");
      } else {
        setView("list");
      }
      setOauthSession(null);
      setOauthCodeInput("");
      setOauthCodeCopied(false);
      setOauthBrowserOpened(false);
      setLocalError(null);
      return;
    }

    if (resolvedView === "api" && (selectedEntry?.methods.length ?? 0) > 1) {
      setView("method");
      setSelectedCloudMethod(null);
      setApiKeyInput("");
      setLocalError(null);
      return;
    }
    if (resolvedView === "cloud" && (selectedEntry?.methods.length ?? 0) > 1) {
      setView("method");
      setSelectedCloudMethod(null);
      setLocalError(null);
      return;
    }
    resetState();
  };

  const submittingLabel = () => {
    if (!props.submitting) return null;
    if (resolvedView === "api") return t("providers.status_saving_api_key");
    if (resolvedView === "custom") {
      return t(isEditingCustomProvider
        ? "providers.custom_edit_submitting_status"
        : "providers.custom_submitting_status");
    }
    if (resolvedView === "cloud") return t("providers.status_connecting_org_provider");
    if (resolvedView === "oauth-code") return t("providers.status_verifying_code");
    if (resolvedView === "oauth-auto") return t("providers.status_waiting_oauth");
    return t("providers.status_opening_auth");
  };

  const stepEntryIndex = (delta: number) => {
    const total = filteredEntries.length;
    if (total <= 0) {
      setActiveEntryIndex(0);
      return;
    }
    setActiveEntryIndex((current) => {
      const normalized = ((current % total) + total) % total;
      return (normalized + delta + total) % total;
    });
  };

  const handleListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (resolvedView !== "list") return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      stepEntryIndex(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      stepEntryIndex(-1);
      return;
    }
    if (event.key === "Enter") {
      const nativeEvent = event.nativeEvent as globalThis.KeyboardEvent & { keyCode?: number };
      if (nativeEvent.isComposing || nativeEvent.keyCode === 229) {
        return;
      }
      const entry = filteredEntries[activeEntryIndex];
      if (!entry) return;
      event.preventDefault();
      handleEntrySelect(entry);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      handleClose();
    }
  };

  const methodDescription = (entry: ProviderAuthEntry, method: ProviderAuthMethod) => {
    const label = methodLabel(method).toLowerCase();
    if (isOpenAiProvider(entry.id, entry.name) && (label.includes("headless") || label.includes("device"))) {
      return isRemoteWorker
        ? "Use OpenAI's device flow for remote workers, where the browser callback may not resolve on your local machine."
        : "Use OpenAI's device flow when the local browser callback is unreliable.";
    }
    if (method.type === "oauth") {
      return "Continue in the browser and let JuggleWork finish the connection automatically.";
    }
    if (method.type === "cloud") {
      return method.description ?? "Use the provider and credential managed by your organization.";
    }
    return "Paste a secret key that JuggleWork stores locally on this device.";
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
    >
      <DialogContent className="flex max-h-[calc(100vh-2rem)] min-h-0 w-full max-w-lg flex-col overflow-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("providers.connect_title")}</DialogTitle>
          <DialogDescription>
            Sign in to services or use providers managed by your organization.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4">
          {errorMessage ? (
            <div className="rounded-xl border border-red-7/30 bg-red-1/40 px-3 py-2 text-xs text-red-11">
              {errorMessage}
            </div>
          ) : props.loading ? (
            <div className="rounded-xl border border-gray-6 bg-gray-1/60 px-4 py-3 text-sm text-gray-10 animate-pulse">
              Loading providers…
            </div>
          ) : null}

          {!props.loading ? (
            <div className="-mr-1 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
              {resolvedView === "list" ? (
                <div className="space-y-3" role="presentation" onKeyDown={handleListKeyDown}>
                  <div className="relative flex items-center mb-1">
                    <Search size={16} className="absolute left-3 text-gray-9" />
                    <input
                      ref={searchInputRef}
                      type="text"
                      placeholder="Filter providers by name or ID"
                      value={searchQuery}
                      onChange={(event) => {
                        setSearchQuery(event.currentTarget.value);
                        setActiveEntryIndex(0);
                      }}
                      autoComplete="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      disabled={actionDisabled}
                      className="w-full rounded-xl bg-gray-2 px-9 py-2.5 text-[13px] text-gray-12 placeholder:text-gray-9 border border-gray-6/60 focus:border-gray-8 focus:bg-gray-1 focus:outline-none transition-colors shadow-sm"
                    />
                  </div>

                  {showCustomEntry ? (
                    <button
                      type="button"
                      className="w-full group flex items-start gap-3.5 rounded-xl border border-dashed border-gray-6/70 px-3.5 py-3 text-left transition-all duration-200 hover:bg-gray-3/30 disabled:opacity-60 disabled:cursor-not-allowed"
                      disabled={actionDisabled}
                      onClick={openCustomView}
                    >
                      <div className="flex size-8 shrink-0 items-center justify-center rounded-full border border-gray-5/60 bg-gray-2 shadow-sm">
                        <Plus size={16} className="text-gray-11" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-[14px] font-medium text-gray-12 truncate tracking-tight">
                            {t("providers.custom_title")}
                          </div>
                          <div className="text-[12px] font-medium text-gray-9 group-hover:text-gray-12 transition-colors flex items-center gap-0.5 opacity-80 group-hover:opacity-100 shrink-0">
                            {t("common.add")}
                            <ChevronRight size={14} className="opacity-0 -ml-2 group-hover:opacity-100 group-hover:ml-0 transition-all duration-200" />
                          </div>
                        </div>
                        <div className="text-[11px] text-gray-9 mt-0.5">
                          {t("providers.custom_card_desc")}
                        </div>
                      </div>
                    </button>
                  ) : null}

                  {filteredEntries.length ? (
                    filteredEntries.map((entry, index) => (
                      <button
                        key={entry.id}
                        type="button"
                        className={`w-full group flex items-start gap-3.5 rounded-xl px-3.5 py-3 text-left transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed ${
                          index === activeEntryIndex ? "bg-gray-3/60" : "hover:bg-gray-3/30"
                        }`}
                        disabled={actionDisabled}
                        onMouseEnter={() => setActiveEntryIndex(index)}
                        onClick={() => handleEntrySelect(entry)}
                      >
                        <div className="flex size-8 shrink-0 items-center justify-center rounded-full border border-gray-5/60 bg-gray-2 shadow-sm overflow-hidden">
                          <ProviderIcon providerId={entry.id} size={18} className="text-gray-12" />
                        </div>

                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0 flex items-center gap-2">
                              <div className="text-[14px] font-medium text-gray-12 truncate tracking-tight">
                                {entry.name}
                              </div>
                            </div>
                            <div className="flex items-center justify-end shrink-0">
                              {entry.connected ? (
                                <div className="flex items-center gap-1 text-[11px] font-medium text-green-11 bg-green-4/20 border border-green-5/30 px-1.5 py-0.5 rounded-md">
                                  <CheckCircle2 size={12} strokeWidth={2.5} />
                                  Connected
                                </div>
                              ) : (
                                <div className="text-[12px] font-medium text-gray-9 group-hover:text-gray-12 transition-colors flex items-center gap-0.5 opacity-80 group-hover:opacity-100">
                                  Connect
                                  <ChevronRight size={14} className="opacity-0 -ml-2 group-hover:opacity-100 group-hover:ml-0 transition-all duration-200" />
                                </div>
                              )}
                            </div>
                          </div>
                          <div className="text-[11px] text-gray-9 font-mono truncate mt-0.5 opacity-60 group-hover:opacity-80 transition-opacity">
                            {entry.id}
                          </div>

                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {entry.methods.map((method) => (
                              <span
                                key={`${entry.id}-${method.type}-${method.methodIndex ?? method.cloudProviderId ?? method.label}`}
                                className={`text-[10px] font-medium px-2 py-0.5 rounded-md border ${
                                  method.type === "oauth"
                                    ? "bg-indigo-3/30 text-indigo-11 border-indigo-5/30"
                                    : method.type === "cloud"
                                      ? "bg-emerald-3/30 text-emerald-11 border-emerald-5/30"
                                      : "bg-gray-3/40 text-gray-11 border-gray-6/40"
                                }`}
                              >
                                {methodLabel(method)}
                              </span>
                            ))}
                          </div>
                        </div>
                      </button>
                    ))
                  ) : (
                    <div className="text-sm text-gray-10 pt-2">
                      {entries.length ? t("providers.no_search_results") : t("providers.no_available")}
                    </div>
                  )}

                  <div className="text-[11px] text-gray-9">{t("providers.keyboard_hint")}</div>
                </div>
              ) : null}

              {resolvedView === "method" && selectedEntry ? (
                <div className="rounded-xl border border-gray-6/40 bg-gray-2/50 shadow-sm p-5 space-y-4">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="text-sm font-medium text-gray-12">{selectedEntry.name}</div>
                      <div className="text-xs text-gray-10 mt-1">Choose how you'd like to connect.</div>
                    </div>
                    <Button variant="outline" onClick={handleBack} disabled={actionDisabled}>
                      Back
                    </Button>
                  </div>
                  <div className="grid gap-2">
                    {selectedEntry.methods.map((method) => (
                      <button
                        key={`${selectedEntry.id}-${method.type}-${method.methodIndex ?? method.cloudProviderId ?? method.label}`}
                        type="button"
                        className={`w-full rounded-xl border px-4 py-3.5 text-left transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed ${
                          method.type === "oauth"
                            ? "border-indigo-5/40 bg-indigo-3/20 hover:bg-indigo-4/30 shadow-sm"
                            : "border-gray-5/50 bg-gray-2 hover:bg-gray-3/50 shadow-sm"
                        }`}
                        onClick={() => void handleMethodSelect(method)}
                        disabled={actionDisabled}
                      >
                        <div className="text-sm font-medium text-gray-12">{methodLabel(method)}</div>
                        <div className="mt-1 text-xs text-gray-10">{methodDescription(selectedEntry, method)}</div>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              {resolvedView === "api" && selectedEntry ? (
                <div className="rounded-xl border border-gray-6/40 bg-gray-2/50 shadow-sm p-5 space-y-4">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="text-sm font-medium text-gray-12">{selectedEntry.name}</div>
                      <div className="text-xs text-gray-10 mt-1">
                        Paste your API key to connect.
                      </div>
                    </div>
                    <Button variant="outline" onClick={handleBack} disabled={actionDisabled}>
                      Back
                    </Button>
                  </div>
                  <TextInput
                    label="API key"
                    type="password"
                    placeholder="sk-..."
                    value={apiKeyInput}
                    onChange={(event) => {
                      setApiKeyInput(event.currentTarget.value);
                      if (localError) setLocalError(null);
                    }}
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    disabled={actionDisabled}
                  />
                  {selectedEntry.env.length > 0 ? (
                    <div className="text-[11px] text-gray-9">
                      {t("providers.env_vars")}: <span className="font-mono">{selectedEntry.env.join(", ")}</span>
                    </div>
                  ) : null}
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[11px] text-gray-9">Keys are stored locally by OpenCode.</div>
                    <Button
                      onClick={handleApiSubmit}
                      disabled={actionDisabled || !apiKeyInput.trim()}
                    >
                      {props.submitting ? (
                        <>
                          <Loader2 className="size-4 animate-spin" />
                          Saving…
                        </>
                      ) : (
                        "Save key"
                      )}
                    </Button>
                  </div>
                </div>
              ) : null}

              {resolvedView === "custom" ? (
                <div className="rounded-xl border border-gray-6/40 bg-gray-2/50 shadow-sm p-5 space-y-4">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="text-sm font-medium text-gray-12">
                        {t(hasCustomProviderDraft
                          ? isEditingCustomProvider
                            ? "providers.custom_edit_title"
                            : "providers.custom_details_title"
                          : "providers.custom_title")}
                      </div>
                      <div className="text-xs text-gray-10 mt-1">
                        {t(hasCustomProviderDraft
                          ? isEditingCustomProvider
                            ? "providers.custom_edit_subtitle"
                            : "providers.custom_details_subtitle"
                          : "providers.custom_subtitle")}
                      </div>
                    </div>
                    <Button variant="outline" onClick={handleBack} disabled={actionDisabled}>
                      {t(hasCustomProviderDraft ? "common.close" : "common.back")}
                    </Button>
                  </div>

                  <TextInput
                    label={t("providers.custom_name_label")}
                    placeholder={t("providers.custom_name_placeholder")}
                    value={customForm.name}
                    onChange={(event) => {
                      const name = event.currentTarget.value;
                      setCustomForm((current) => ({ ...current, name }));
                      if (localError) setLocalError(null);
                    }}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={actionDisabled || isViewingCustomProvider}
                  />

                  <TextInput
                    label={t("providers.custom_id_label")}
                    placeholder="my-gateway"
                    hint={customProviderIdHint}
                    value={customProviderId}
                    onChange={(event) => {
                      const providerId = event.currentTarget.value;
                      setCustomIdEdited(true);
                      setCustomForm((current) => ({ ...current, providerId }));
                      if (localError) setLocalError(null);
                    }}
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    disabled={actionDisabled || hasCustomProviderDraft}
                  />

                  <TextInput
                    label={t("providers.custom_base_url_label")}
                    placeholder="https://api.example.com/v1"
                    hint={t("providers.custom_base_url_hint")}
                    value={customForm.baseUrl}
                    onChange={(event) => {
                      const baseUrl = event.currentTarget.value;
                      setCustomForm((current) => ({ ...current, baseUrl }));
                      if (localError) setLocalError(null);
                    }}
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    disabled={actionDisabled || isViewingCustomProvider}
                  />

                  {!isViewingCustomProvider ? (
                    <TextInput
                      label={t("providers.api_key_label")}
                      type="password"
                      placeholder="sk-..."
                      hint={isEditingCustomProvider ? t("providers.custom_api_key_keep_hint") : undefined}
                      value={customForm.apiKey}
                      onChange={(event) => {
                        const apiKey = event.currentTarget.value;
                        setCustomForm((current) => ({ ...current, apiKey }));
                        if (localError) setLocalError(null);
                      }}
                      autoComplete="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      disabled={actionDisabled}
                    />
                  ) : null}

                  <label className="block">
                    <div className="mb-1 text-xs font-medium text-dls-secondary">
                      {t("providers.custom_models_label")}
                    </div>
                    <textarea
                      rows={4}
                      placeholder={"gpt-4o\nclaude-sonnet-4-5 = Claude Sonnet 4.5"}
                      value={customForm.models}
                      onChange={(event) => {
                        const models = event.currentTarget.value;
                        setCustomForm((current) => ({ ...current, models }));
                        if (localError) setLocalError(null);
                      }}
                      autoComplete="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      disabled={actionDisabled || isViewingCustomProvider}
                      className="w-full resize-y rounded-lg bg-dls-surface px-3 py-2 font-mono text-xs text-dls-text placeholder:text-dls-secondary border border-dls-border shadow-sm focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.2)]"
                    />
                    <div className="mt-1 text-xs text-dls-secondary">
                      {t("providers.custom_models_hint")}{" "}
                      {t("providers.custom_models_detected", { count: customModels.length })}
                    </div>
                  </label>

                  <div className="grid grid-cols-2 gap-3">
                    <TextInput
                      label={t("providers.custom_context_limit_label")}
                      inputMode="numeric"
                      placeholder="200000"
                      value={customForm.contextLimit}
                      onChange={(event) => {
                        const contextLimit = event.currentTarget.value;
                        setCustomForm((current) => ({ ...current, contextLimit }));
                        if (localError) setLocalError(null);
                      }}
                      autoComplete="off"
                      spellCheck={false}
                      disabled={actionDisabled || isViewingCustomProvider}
                    />
                    <TextInput
                      label={t("providers.custom_output_limit_label")}
                      inputMode="numeric"
                      placeholder="32000"
                      value={customForm.outputLimit}
                      onChange={(event) => {
                        const outputLimit = event.currentTarget.value;
                        setCustomForm((current) => ({ ...current, outputLimit }));
                        if (localError) setLocalError(null);
                      }}
                      autoComplete="off"
                      spellCheck={false}
                      disabled={actionDisabled || isViewingCustomProvider}
                    />
                  </div>
                  <div className="text-[11px] text-gray-9">
                    {t("providers.custom_limits_hint")}
                  </div>

                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[11px] text-gray-9">
                      {t("providers.custom_storage_note")}
                    </div>
                    {isViewingCustomProvider ? (
                      <Button
                        onClick={() => {
                          setCustomProviderEditing(true);
                          setLocalError(null);
                        }}
                      >
                        {t("common.edit")}
                      </Button>
                    ) : (
                      <Button
                        onClick={() => void handleCustomSubmit()}
                        disabled={
                          actionDisabled ||
                          !customProviderId.trim() ||
                          !customForm.baseUrl.trim() ||
                          customModels.length === 0
                        }
                      >
                        {props.submitting ? (
                          <>
                            <Loader2 className="size-4 animate-spin" />
                            {t(isEditingCustomProvider
                              ? "providers.custom_edit_submitting"
                              : "providers.custom_submitting")}
                          </>
                        ) : (
                          t(isEditingCustomProvider
                            ? "providers.custom_edit_submit"
                            : "providers.custom_submit")
                        )}
                      </Button>
                    )}
                  </div>
                </div>
              ) : null}

              {resolvedView === "cloud" && selectedEntry && selectedCloudMethod ? (
                <div className="rounded-xl border border-gray-6/40 bg-gray-2/50 shadow-sm p-5 space-y-4">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="text-sm font-medium text-gray-12">{selectedEntry.name}</div>
                      <div className="text-xs text-gray-10 mt-1">Connect with the provider managed by your organization.</div>
                    </div>
                    <Button variant="outline" onClick={handleBack} disabled={actionDisabled}>
                      Back
                    </Button>
                  </div>
                  <div className="text-xs text-gray-9">
                    {selectedCloudMethod.description ?? "Use the provider and credential managed by your organization."}
                  </div>
                  {(selectedCloudMethod.modelCount ?? 0) > 0 ? (
                    <div className="rounded-lg border border-gray-6/60 bg-gray-1/60 px-3 py-2 text-[11px] text-gray-9">
                      {(selectedCloudMethod.modelCount ?? 0) === 1
                        ? t("providers.curated_models_one", { count: selectedCloudMethod.modelCount ?? 0 })
                        : t("providers.curated_models_other", { count: selectedCloudMethod.modelCount ?? 0 })}
                    </div>
                  ) : null}
                  {(selectedCloudMethod.env?.length ?? 0) > 0 ? (
                    <div className="text-[11px] text-gray-9">
                      {t("providers.env_vars")}: <span className="font-mono">{selectedCloudMethod.env?.join(", ")}</span>
                    </div>
                  ) : null}
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[11px] text-gray-9">
                      {t("providers.org_install_hint")}
                    </div>
                    <Button onClick={handleCloudSubmit} disabled={actionDisabled}>
                      {props.submitting ? t("providers.connecting") : t("settings.connect_provider")}
                    </Button>
                  </div>
                </div>
              ) : null}

              {resolvedView === "oauth-code" && selectedEntry && oauthSession ? (
                <div className="rounded-xl border border-gray-6/40 bg-gray-2/50 shadow-sm p-5 space-y-4">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="text-sm font-medium text-gray-12">{selectedEntry.name}</div>
                      <div className="text-xs text-gray-10 mt-1">Finish OAuth by pasting the authorization code.</div>
                    </div>
                    <Button variant="outline" onClick={handleBack} disabled={actionDisabled}>
                      Back
                    </Button>
                  </div>
                  <div className="text-xs text-gray-9">
                    Complete sign-in in your browser, then paste the code here.
                  </div>
                  {oauthInstructions ? (
                    <div className="rounded-lg border border-gray-6/60 bg-gray-1/60 px-3 py-2 text-[11px] text-gray-9 font-mono break-all">
                      {oauthInstructions}
                    </div>
                  ) : null}
                  <TextInput
                    label="Authorization code"
                    type="text"
                    placeholder="Paste code"
                    value={oauthCodeInput}
                    onChange={(event) => {
                      setOauthCodeInput(event.currentTarget.value);
                      if (localError) setLocalError(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      void handleOauthCodeSubmit();
                    }}
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    disabled={actionDisabled}
                  />
                  <div className="flex items-center justify-between gap-3">
                    <Button
                      variant="outline"
                      onClick={() => {
                        void openOauthUrl(oauthSession.authorization.url ?? "");
                      }}
                    >
                      Open browser again
                    </Button>
                    <Button
                      onClick={() => void handleOauthCodeSubmit()}
                      disabled={actionDisabled || !oauthCodeInput.trim()}
                    >
                      {props.submitting ? "Verifying..." : "Complete connection"}
                    </Button>
                  </div>
                </div>
              ) : null}

              {resolvedView === "oauth-auto" && selectedEntry && oauthSession ? (
                <div className="rounded-xl border border-gray-6/40 bg-gray-2/50 shadow-sm p-5 space-y-4">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="text-sm font-medium text-gray-12">{selectedEntry.name}</div>
                      <div className="text-xs text-gray-10 mt-1">Waiting for browser confirmation.</div>
                    </div>
                    <Button variant="outline" onClick={handleBack} disabled={actionDisabled}>
                      Back
                    </Button>
                  </div>
                  {isOpenAiHeadlessSession ? (
                    <div className="space-y-2 text-xs text-gray-9">
                      <div>You'll need to sign in to your OpenAI account and provide the code below.</div>
                      <div>The first time you do this you'll need to enable Device auth in your account settings.</div>
                      <div>ChatGPT &gt; Account Settings &gt; Security &gt; Enable device code authorization</div>
                      <div>When you're ready, copy the code below, and click &quot;Open Browser&quot;.</div>
                    </div>
                  ) : (
                    <div className="text-xs text-gray-9">
                      Sign in in the browser tab we just opened. We will complete the connection automatically.
                    </div>
                  )}
                  {oauthDisplayCode ? (
                    <div className="rounded-xl border border-gray-6/70 bg-gray-2/40 p-3 flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="text-[10px] uppercase tracking-wide text-gray-8">Confirmation code</div>
                        <div className="text-sm text-gray-12 font-mono break-all">{oauthDisplayCode}</div>
                      </div>
                      <Button variant="outline" size="sm" className="shrink-0" onClick={() => void copyOauthDisplayCode()}>
                        {oauthCodeCopied ? "Copied" : "Copy"}
                      </Button>
                    </div>
                  ) : null}
                  {isOpenAiHeadlessSession && !oauthBrowserOpened ? (
                    <div className="flex items-center gap-2 text-xs text-gray-9">
                      <span>Authorization checks will start after you click Open Browser.</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-xs text-gray-9">
                      <Loader2 size={14} className={props.submitting || pollingBusy || oauthAutoBusy ? "animate-spin" : ""} />
                      <span>Checking connection status automatically…</span>
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-3">
                    <Button
                      variant="outline"
                      onClick={() => {
                        void openOauthUrl(oauthSession.authorization.url ?? "");
                      }}
                    >
                      {isOpenAiHeadlessSession
                        ? oauthBrowserOpened
                          ? "Reopen Browser"
                          : "Open Browser"
                        : "Open browser again"}
                    </Button>
                    <div className="text-[11px] text-gray-9 text-right">
                      This window will close once the provider is connected.
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <DialogFooter className="shrink-0 flex-col gap-3">
          <div className="min-h-[16px] text-xs text-gray-10">
            {props.submitting ? submittingLabel() : null}
          </div>
          <DialogClose
            disabled={actionDisabled}
            render={<Button variant="outline" disabled={actionDisabled} />}
          >
            Close
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
