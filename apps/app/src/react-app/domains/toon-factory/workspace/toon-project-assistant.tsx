/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import {
  Archive,
  Bot,
  ChevronDown,
  History,
  LoaderCircle,
  Paperclip,
  Pencil,
  Plus,
  Send,
  Trash2,
  Square,
  Undo2,
  X,
} from "lucide-react";
import type { JuggleWorkServerClient } from "@/app/lib/jugglework-server";
import type { ConnectedTextModelOption } from "@/react-app/infra/provider-list-query";
import type {
  ToonAssistantCanvasProposal,
  ToonAssistantConversation,
  ToonAssistantGenerationProposal,
  ToonAssistantInteraction,
  ToonAssistantMessage,
  ToonAssistantSnapshot,
} from "@jugglework/types/toon-assistant";
import type { ToonAssistantAttachment } from "@jugglework/types/toon-assistant";
import type { ToonModelReference } from "@jugglework/types/toon-factory";
import type { ToonMediaJob } from "@jugglework/types/toon-factory";
import type {
  ToonGenerationAuthorizationState,
  ToonWorkspaceGenerationRecord,
  ToonWorkspaceOperationOutcome,
} from "@jugglework/types/toon-workspace";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";

type AssistantClient = Pick<
  JuggleWorkServerClient,
  | "baseUrl"
  | "createToonAssistantConversation"
  | "listToonAssistantConversations"
  | "getToonAssistantSnapshot"
  | "updateToonAssistantConversation"
  | "deleteToonAssistantConversation"
  | "sendToonAssistantMessage"
  | "stopToonAssistantTurn"
  | "acknowledgeToonAssistantRemoteWarning"
  | "editResendToonAssistantMessage"
  | "listToonAssistantEvents"
  | "listToonAssistantCompletions"
  | "replyToonAssistantInteraction"
  | "executeToonAssistantCanvasProposal"
  | "prepareToonAssistantGeneration"
  | "authorizeToonWorkspaceGeneration"
  | "submitToonWorkspaceGeneration"
  | "getToonWorkspaceGeneration"
  | "adoptToonWorkspaceGenerationCandidate"
  | "queryToonWorkspace"
  | "uploadToonProjectAsset"
>;

type RetainedAssistantState = {
  conversationId: string | null;
  draft: string;
  model: ToonModelReference | null;
  cursor: string | null;
};

const retained = new Map<string, RetainedAssistantState>();

function retainedState(
  endpoint: string,
  workspaceId: string,
  projectId: string,
  defaultModel?: ToonModelReference,
): RetainedAssistantState {
  const key = [endpoint.trim().replace(/\/+$/, ""), workspaceId, projectId]
    .map(encodeURIComponent)
    .join(":");
  const current = retained.get(key);
  if (current) return current;
  const created = {
    conversationId: null,
    draft: "",
    model: defaultModel?.kind === "text" ? defaultModel : null,
    cursor: null,
  };
  retained.set(key, created);
  return created;
}

function id(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function modelValue(model: { providerID: string; modelID: string }): string {
  return `${model.providerID}\u0000${model.modelID}`;
}

export function ToonProjectAssistant(props: {
  client: AssistantClient;
  workspaceId: string;
  projectId: string;
  visible: boolean;
  readOnly?: boolean;
  textModels: ConnectedTextModelOption[];
  defaultModel?: ToonModelReference;
  initialPrompt?: string;
  onInitialPromptConsumed?: () => void;
  onClose: () => void;
  beforeCanvasProposalExecute?: (
    proposal: ToonAssistantCanvasProposal,
  ) => Promise<boolean>;
  canvasLease?: { token: string; generation: number } | null;
  onCanvasProposalCommitted?: (
    proposal: ToonAssistantCanvasProposal,
    outcome: ToonWorkspaceOperationOutcome,
  ) => Promise<void> | void;
  narrow?: boolean;
  pendingAttachment?: ToonAssistantAttachment | null;
  onPendingAttachmentConsumed?: () => void;
}) {
  const retainedRef = useRef(
    retainedState(
      props.client.baseUrl,
      props.workspaceId,
      props.projectId,
      props.defaultModel,
    ),
  );
  const [conversations, setConversations] = useState<
    ToonAssistantConversation[]
  >([]);
  const [conversationId, setConversationId] = useState(
    retainedRef.current.conversationId,
  );
  const [snapshot, setSnapshot] = useState<ToonAssistantSnapshot | null>(null);
  const [draft, setDraft] = useState(retainedRef.current.draft);
  const [model, setModel] = useState<ToonModelReference | null>(
    retainedRef.current.model,
  );
  const [conversationModel, setConversationModel] =
    useState<ToonModelReference | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [completions, setCompletions] = useState<
    Array<{
      kind: "node" | "asset" | "document";
      id: string;
      revision?: string;
      label: string;
      mimeType?: string;
    }>
  >([]);
  const [mentions, setMentions] = useState<
    Array<{
      kind: "node" | "asset" | "document";
      id: string;
      revision?: string;
      label: string;
    }>
  >([]);
  const [attachments, setAttachments] = useState<ToonAssistantAttachment[]>([]);
  const [completionOpen, setCompletionOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [replacementPending, setReplacementPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generationJobs, setGenerationJobs] = useState<
    Record<
      string,
      {
        generation: ToonWorkspaceGenerationRecord;
        job: ToonMediaJob | null;
        authorization: ToonGenerationAuthorizationState | null;
      }
    >
  >({});
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const seenEvents = useRef(new Set<string>());
  const initialPromptRef = useRef<string | null>(null);

  retainedRef.current.conversationId = conversationId;
  retainedRef.current.draft = draft;
  retainedRef.current.model = model;

  const loadConversations = async () => {
    const items = await props.client.listToonAssistantConversations(
      props.workspaceId,
      props.projectId,
    );
    setConversations(items);
    const retainedConversation = items.find(
      (item) => item.id === retainedRef.current.conversationId,
    );
    const selected = retainedConversation ?? items[0] ?? null;
    if (selected) {
      setConversationId(selected.id);
      const selectedModel = selected.model;
      if (selectedModel?.kind === "text") {
        setModel(selectedModel);
        setConversationModel(selectedModel);
      } else setConversationModel(null);
    } else {
      retainedRef.current.conversationId = null;
      setConversationId(null);
    }
    return items;
  };
  const loadSnapshot = async (target = conversationId) => {
    if (!target) {
      setSnapshot(null);
      return null;
    }
    const next = await props.client.getToonAssistantSnapshot(
      props.workspaceId,
      props.projectId,
      target,
    );
    setSnapshot(next);
    const snapshotModel = next.conversation.model;
    if (snapshotModel?.kind === "text") {
      setModel(snapshotModel);
      setConversationModel(snapshotModel);
    } else setConversationModel(null);
    retainedRef.current.cursor = next.cursor;
    return next;
  };
  const createConversation = async (): Promise<ToonAssistantConversation> => {
    if (props.readOnly) throw new Error(t("toon_factory.lease_read_only"));
    if (!model) throw new Error(t("toon_factory.assistant_select_model_first"));
    const created = await props.client.createToonAssistantConversation(
      props.workspaceId,
      props.projectId,
      { model, title: t("toon_factory.assistant_project_conversation") },
    );
    setConversations((items) => [created, ...items]);
    setConversationId(created.id);
    retainedRef.current.conversationId = created.id;
    setSnapshot({
      conversation: created,
      messages: [],
      interactions: [],
      canvasProposals: [],
      subagents: [],
      branches: [],
      remoteContinueWarnings: [],
      activeTurnId: null,
      activeBranchId: null,
      cursor: null,
    });
    setConversationModel(model);
    return created;
  };

  useEffect(() => {
    let cancelled = false;
    void loadConversations()
      .then((items) => {
        if (cancelled) return;
        const target =
          items.find((item) => item.id === retainedRef.current.conversationId)
            ?.id ??
          items[0]?.id ??
          null;
        if (target) {
          setConversationId(target);
          void loadSnapshot(target);
        }
      })
      .catch(
        (cause) =>
          !cancelled &&
          setError(cause instanceof Error ? cause.message : String(cause)),
      );
    return () => {
      cancelled = true;
    };
  }, [props.workspaceId, props.projectId]);

  useEffect(() => {
    if (replacementPending && snapshot?.messages.some((message) => message.id === replacementPending)) setReplacementPending(null);
  }, [replacementPending, snapshot]);

  useEffect(() => {
    if (!props.visible || !conversationId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const page = await props.client.listToonAssistantEvents(
          props.workspaceId,
          props.projectId,
          conversationId,
          retainedRef.current.cursor,
        );
        const fresh = page.items.filter(
          (event) => !seenEvents.current.has(event.id),
        );
        fresh.forEach((event) => seenEvents.current.add(event.id));
        retainedRef.current.cursor = page.cursor;
        if (!cancelled && fresh.length) await loadSnapshot(conversationId);
      } catch (cause) {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [props.visible, conversationId, props.workspaceId, props.projectId]);

  const send = async (
    sourceMessage?: ToonAssistantMessage,
    initialText?: string,
  ) => {
    const text =
      initialText?.trim() ||
      (sourceMessage
        ? window
            .prompt(
              t("toon_factory.assistant_edit_message"),
              sourceMessage.parts.find((part) => part.type === "text")?.text ??
                "",
            )
            ?.trim()
        : draft.trim());
    if (!text || !model || busy || props.readOnly) return;
    setBusy(true);
    setError(null);
    try {
      const conversation = conversationId
        ? (conversations.find((item) => item.id === conversationId) ??
          snapshot?.conversation)
        : await createConversation();
      if (!conversation)
        throw new Error(t("toon_factory.assistant_conversation_unavailable"));
      const input = {
        turnId: id("turn"),
        messageId: id("message"),
        text,
        model,
        attachments,
        mentions: mentions.map(({ label: _label, ...mention }) => mention),
      };
      if (sourceMessage) {
        const response = await props.client.editResendToonAssistantMessage(
          props.workspaceId,
          props.projectId,
          conversation.id,
          {
            ...input,
            sourceMessageId: sourceMessage.id,
            detachActiveDescendants: false,
          },
        );
        setReplacementPending(response.pending ? input.messageId : null);
      } else
        await props.client.sendToonAssistantMessage(
          props.workspaceId,
          props.projectId,
          conversation.id,
          input,
        );
      setDraft("");
      setMentions([]);
      setAttachments([]);
      retainedRef.current.draft = "";
      await loadSnapshot(conversation.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const prompt = props.initialPrompt?.trim();
    if (
      !prompt ||
      !props.visible ||
      busy ||
      !model ||
      initialPromptRef.current === prompt
    )
      return;
    initialPromptRef.current = prompt;
    void send(undefined, prompt)
      .then(() => props.onInitialPromptConsumed?.())
      .catch(() => {
        initialPromptRef.current = null;
      });
  }, [
    props.initialPrompt,
    props.visible,
    model,
    conversationId,
    conversations.length,
  ]);
  useEffect(() => {
    if (!props.pendingAttachment) return;
    setAttachments((current) => [
      ...current.filter(
        (entry) =>
          entry.kind !== props.pendingAttachment!.kind ||
          entry.targetId !== props.pendingAttachment!.targetId,
      ),
      props.pendingAttachment!,
    ]);
    props.onPendingAttachmentConsumed?.();
  }, [props.pendingAttachment]);

  useEffect(() => {
    if (!props.narrow) return;
    const ownerDocument = document;
    const previous =
      typeof HTMLElement !== "undefined" &&
      ownerDocument.activeElement instanceof HTMLElement
        ? ownerDocument.activeElement
        : null;
    composerRef.current?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        props.onClose();
        return;
      }
      if (event.key !== "Tab" || !surfaceRef.current) return;
      const focusable = [
        ...surfaceRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ];
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && ownerDocument.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && ownerDocument.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    ownerDocument.addEventListener("keydown", trap);
    return () => {
      ownerDocument.removeEventListener("keydown", trap);
      previous?.focus();
    };
  }, [props.narrow]);

  const findCompletions = async () => {
    setCompletionOpen(true);
    try {
      const result = await props.client.listToonAssistantCompletions(
        props.workspaceId,
        props.projectId,
        draft.split(/\s/).at(-1)?.replace(/^@/, "") ?? "",
      );
      setCompletions(result.items.slice(0, 12));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const uploadAttachment = async (file: File) => {
    if (props.readOnly) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await props.client.uploadToonProjectAsset(
        props.workspaceId,
        props.projectId,
        file,
        {
          operationId: id("assistant-asset-upload"),
          assetId: id("asset"),
          filename: file.name,
          ...(file.type ? { declaredMimeType: file.type } : {}),
          origin: "imported",
          actor: { kind: "human" },
        },
      );
      const asset = (
        outcome.result as
          | {
              asset?: {
                id: string;
                title: string;
                checksum: string;
                mimeType: string;
              };
            }
          | undefined
      )?.asset;
      if (!asset) throw new Error(t("toon_factory.attachment_upload_failed"));
      setAttachments((current) => [
        ...current.filter(
          (entry) => entry.kind !== "asset" || entry.targetId !== asset.id,
        ),
        {
          id: id("attachment"),
          kind: "asset",
          targetId: asset.id,
          revision: asset.checksum,
          label: asset.title,
          mimeType: asset.mimeType,
        },
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const rename = async (conversation: ToonAssistantConversation) => {
    const title = window
      .prompt(t("toon_factory.assistant_conversation_name"), conversation.title)
      ?.trim();
    if (!title) return;
    const updated = await props.client.updateToonAssistantConversation(
      props.workspaceId,
      props.projectId,
      conversation.id,
      { title },
    );
    setConversations((items) =>
      items.map((item) => (item.id === updated.id ? updated : item)),
    );
  };
  const archive = async (conversation: ToonAssistantConversation) => {
    await props.client.updateToonAssistantConversation(
      props.workspaceId,
      props.projectId,
      conversation.id,
      { archived: true },
    );
    const items = await loadConversations();
    const next = items.find((item) => item.id !== conversation.id) ?? null;
    setConversationId(next?.id ?? null);
    setSnapshot(null);
    setConversationModel(null);
    if (next) await loadSnapshot(next.id);
  };
  const remove = async (conversation: ToonAssistantConversation) => {
    if (props.readOnly || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await props.client.deleteToonAssistantConversation(props.workspaceId, props.projectId, conversation.id);
      if (result.deleted) {
        const items = await loadConversations();
        const next = items.find((item) => item.id !== conversation.id) ?? null;
        setConversationId(next?.id ?? null);
        setSnapshot(null);
        setConversationModel(null);
        if (next) await loadSnapshot(next.id);
      } else {
        const items = await loadConversations();
        const pending = items.find((item) => item.id === conversation.id);
        if (pending) setSnapshot((current) => current ? { ...current, conversation: pending } : current);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const decideCanvasProposal = async (
    proposal: ToonAssistantCanvasProposal,
    decision: "approve" | "deny",
  ) => {
    if (busy || props.readOnly) return;
    setBusy(true);
    setError(null);
    try {
      if (
        decision === "approve" &&
        props.beforeCanvasProposalExecute &&
        !(await props.beforeCanvasProposalExecute(proposal))
      )
        return;
      const result = await props.client.executeToonAssistantCanvasProposal(
        props.workspaceId,
        props.projectId,
        proposal.conversationId,
        proposal.id,
        {
          decision,
          ...(decision === "approve" && props.canvasLease
            ? {
                leaseToken: props.canvasLease.token,
                leaseGeneration: props.canvasLease.generation,
              }
            : {}),
        },
      );
      if (decision === "approve" && "outcome" in result)
        await props.onCanvasProposalCommitted?.(
          result.proposal,
          result.outcome,
        );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      await loadSnapshot(proposal.conversationId).catch(() => undefined);
      setBusy(false);
    }
  };
  const generationFromInteraction = (
    interaction: ToonAssistantInteraction,
  ): ToonAssistantGenerationProposal | null => {
    const payload = interaction.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      return null;
    const proposal =
      "proposal" in payload
        ? (payload as { proposal?: unknown }).proposal
        : payload;
    return proposal &&
      typeof proposal === "object" &&
      !Array.isArray(proposal) &&
      "id" in proposal &&
      "plan" in proposal
      ? (proposal as ToonAssistantGenerationProposal)
      : null;
  };
  const generationInteraction = (
    generationId: string,
  ): ToonAssistantInteraction | undefined =>
    snapshot?.interactions.find(
      (item) => generationFromInteraction(item)?.id === generationId,
    );
  const generationProposals = (snapshot?.interactions ?? [])
    .map(generationFromInteraction)
    .filter((proposal): proposal is ToonAssistantGenerationProposal =>
      Boolean(proposal),
    );
  const prepareGeneration = async (
    proposal: ToonAssistantGenerationProposal,
  ) => {
    if (busy || props.readOnly) return;
    setBusy(true);
    setError(null);
    try {
      await props.client.prepareToonAssistantGeneration(
        props.workspaceId,
        props.projectId,
        proposal.conversationId,
        proposal,
      );
      await loadSnapshot(proposal.conversationId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!props.visible || !generationProposals.length) return;
    let cancelled = false;
    const poll = async () => {
      const results = await Promise.all(
        generationProposals.map(
          async (proposal) =>
            [
              proposal.id,
              await props.client.getToonWorkspaceGeneration(
                props.workspaceId,
                props.projectId,
                proposal.id,
              ),
            ] as const,
        ),
      );
      if (!cancelled)
        setGenerationJobs((current) => ({
          ...current,
          ...Object.fromEntries(results),
        }));
    };
    void poll().catch(
      (cause) =>
        !cancelled &&
        setError(cause instanceof Error ? cause.message : String(cause)),
    );
    const timer = setInterval(() => void poll().catch(() => undefined), 1_500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [
    props.visible,
    props.workspaceId,
    props.projectId,
    generationProposals.map((proposal) => proposal.id).join("\u0000"),
  ]);
  useEffect(() => {
    const pending = Object.entries(generationJobs)
      .filter(
        ([, record]) =>
          !record.job ||
          !["completed", "failed", "cancelled", "submission_unknown"].includes(
            record.job.status,
          ),
      )
      .map(([generationId]) => generationId);
    if (!props.visible || !pending.length) return;
    let cancelled = false;
    const poll = async () => {
      const results = await Promise.all(
        pending.map(
          async (generationId) =>
            [
              generationId,
              await props.client.getToonWorkspaceGeneration(
                props.workspaceId,
                props.projectId,
                generationId,
              ),
            ] as const,
        ),
      );
      if (!cancelled)
        setGenerationJobs((current) => ({
          ...current,
          ...Object.fromEntries(results),
        }));
    };
    const timer = setInterval(() => void poll().catch(() => undefined), 1_500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [
    props.visible,
    props.workspaceId,
    props.projectId,
    Object.entries(generationJobs)
      .map(
        ([id, record]) =>
          `${id}:${record.job?.status ?? record.generation.status}`,
      )
      .join("\u0000"),
  ]);
  const authorizeGeneration = async (interaction: ToonAssistantInteraction) => {
    const proposal = generationFromInteraction(interaction);
    if (!proposal || proposal.state !== "awaiting-human-authorization") return;
    setBusy(true);
    setError(null);
    try {
      const references = await Promise.all(
        proposal.plan.references.map(async (reference) => {
          if (reference.kind !== "asset")
            throw new Error(
              "Paid generation references must be project assets.",
            );
          const response = await props.client.queryToonWorkspace(
            props.workspaceId,
            props.projectId,
            { kind: "asset.read", assetId: reference.id },
          );
          if (response.kind !== "asset.read")
            throw new Error("Generation asset reference is unavailable.");
          if (
            reference.revision &&
            reference.revision !== response.asset.checksum
          )
            throw new Error(
              "A generation asset changed. Prepare and authorize a new exact plan.",
            );
          return response.asset.path;
        }),
      );
      const plan =
        proposal.plan.kind === "image"
          ? {
              kind: "image" as const,
              model: proposal.plan.model as ToonModelReference & {
                kind: "image";
              },
              object: proposal.plan.object,
              quantity: proposal.plan.quantity,
              prompt: proposal.plan.prompt,
              referencePaths: references,
              referenceScope: "project" as const,
              executionCount: proposal.plan.executionCount,
              knownCost: proposal.plan.knownCost,
              mode: String(
                proposal.plan.parameters.mode ??
                  (references.length ? "image-to-image" : "text-to-image"),
              ) as "text-to-image" | "image-to-image" | "multi-image-to-image",
              ...(typeof proposal.plan.parameters.size === "string"
                ? { size: proposal.plan.parameters.size }
                : {}),
            }
          : {
              kind: "video" as const,
              model: proposal.plan.model as ToonModelReference & {
                kind: "video";
              },
              object: proposal.plan.object,
              quantity: proposal.plan.quantity,
              prompt: proposal.plan.prompt,
              referencePaths: references,
              referenceScope: "project" as const,
              executionCount: proposal.plan.executionCount,
              knownCost: proposal.plan.knownCost,
              mode: String(
                proposal.plan.parameters.mode ??
                  (references.length ? "image-to-video" : "text-to-video"),
              ) as "text-to-video" | "image-to-video",
              durationSeconds: Number(proposal.plan.parameters.durationSeconds),
              resolution: String(proposal.plan.parameters.resolution),
            };
      const exact = {
        requestId: proposal.requestId,
        episodeId: proposal.episodeId,
        workflowRecordId: proposal.workflowRecordId,
        canvasId: proposal.canvasId,
        nodeId: proposal.nodeId,
        stepId: proposal.workflowRecordId,
        plan,
      };
      const authorized = await props.client.authorizeToonWorkspaceGeneration(
        props.workspaceId,
        props.projectId,
        proposal.id,
        { ...exact, operationId: id("authorize-generation") },
      );
      const status = await props.client.getToonWorkspaceGeneration(
        props.workspaceId,
        props.projectId,
        proposal.id,
      );
      if (authorized.planFingerprint === status.generation.requestHash && authorized.requestSnapshot.requestId === status.generation.requestId && JSON.stringify(authorized.planSummary) === JSON.stringify(exact.plan)) {
        setGenerationJobs((current) => ({ ...current, [proposal.id]: status }));
      }
      await loadSnapshot(interaction.conversationId);
    } catch (cause) {
      const status = await props.client
        .getToonWorkspaceGeneration(
          props.workspaceId,
          props.projectId,
          proposal.id,
        )
        .catch(() => null);
      if (status)
        setGenerationJobs((current) => ({ ...current, [proposal.id]: status }));
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const submitGeneration = async (generationId: string) => {
    const record = generationJobs[generationId];
    const authorization = record?.authorization;
    if (!authorization || authorization.planFingerprint !== record.generation.requestHash || authorization.requestId !== record.generation.requestId || busy || props.readOnly) return;
    setBusy(true);
    setError(null);
    try {
      await props.client.submitToonWorkspaceGeneration(
        props.workspaceId,
        props.projectId,
        generationId,
        { authorizationId: authorization.authorizationId, expectedPlanFingerprint: authorization.planFingerprint },
      );
      const status = await props.client.getToonWorkspaceGeneration(
        props.workspaceId,
        props.projectId,
        generationId,
      );
      setGenerationJobs((current) => ({ ...current, [generationId]: status }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const denyProtectedInteraction = async (
    interaction: ToonAssistantInteraction,
  ) => {
    setBusy(true);
    setError(null);
    try {
      await props.client.replyToonAssistantInteraction(
        props.workspaceId,
        props.projectId,
        interaction.conversationId,
        interaction.id,
        { decision: "deny" },
      );
      await loadSnapshot(interaction.conversationId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      ref={surfaceRef}
      className="flex h-full min-h-0 flex-col"
      role={props.narrow ? "dialog" : undefined}
      aria-modal={props.narrow ? true : undefined}
      data-testid="toon-project-assistant-ui"
    >
      <header className="flex items-center justify-between gap-2 border-b border-dls-border pb-3">
        <div className="flex min-w-0 items-center gap-2">
          <Bot className="size-4 shrink-0 text-dls-accent" />
          <div className="min-w-0">
            <h2 className="truncate text-xs font-semibold">
              {snapshot?.conversation.title ??
                t("toon_factory.assistant_project_conversation")}
            </h2>
            <p className="text-[9px] text-dls-secondary">
              {t("toon_factory.assistant_persistent_conversation")}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={props.readOnly}
            title={
              props.readOnly
                ? t("toon_factory.lease_read_only")
                : t("toon_factory.assistant_new_conversation")
            }
            onClick={() =>
              void createConversation().catch((cause) =>
                setError(String(cause)),
              )
            }
            className="rounded p-1.5 hover:bg-dls-hover disabled:opacity-40"
          >
            <Plus className="size-3.5" />
          </button>
          <button
            type="button"
            title={t("toon_factory.assistant_conversation_history")}
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen(!historyOpen)}
            className="rounded p-1.5 hover:bg-dls-hover"
          >
            <History className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label={t("toon_factory.close_assistant")}
            onClick={props.onClose}
            className="rounded p-1.5 hover:bg-dls-hover"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </header>
      {historyOpen ? (
        <div
          className="absolute inset-x-3 top-14 z-20 max-h-64 overflow-auto rounded-xl border border-dls-border bg-background p-2 shadow-xl"
          role="menu"
          data-testid="toon-assistant-history"
        >
          {conversations.map((conversation) => (
            <div
              key={conversation.id}
              className="group flex items-center gap-1"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setConversationId(conversation.id);
                  setHistoryOpen(false);
                  const selectedModel = conversation.model;
                  setModel(selectedModel);
                  setConversationModel(selectedModel);
                  void loadSnapshot(conversation.id);
                }}
                className={cn(
                  "min-w-0 flex-1 truncate rounded-lg px-2 py-2 text-left text-[10px]",
                  conversation.id === conversationId
                    ? "bg-dls-active text-dls-accent"
                    : "hover:bg-dls-hover",
                )}
                disabled={conversation.state === "deleting"}
              >
                {conversation.title}
                {conversation.state === "deleting" ? ` · ${t("toon_factory.assistant_cleanup_pending_short")}` : ""}
              </button>
              <button
                type="button"
                title="Rename"
                onClick={() => void rename(conversation)}
              >
                <Pencil className="size-3" />
              </button>
              <button
                type="button"
                title="Archive"
                onClick={() => void archive(conversation)}
              >
                <Archive className="size-3" />
              </button>
              <button
                type="button"
                title={conversation.state === "deleting" ? t("toon_factory.assistant_cleanup_retry") : t("toon_factory.assistant_delete_conversation")}
                disabled={props.readOnly || busy}
                onClick={() => void remove(conversation)}
              >
                {conversation.state === "deleting" ? <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" /> : <Trash2 className="size-3" />}
              </button>
            </div>
          ))}
          {!conversations.length ? (
            <p className="p-2 text-[10px] text-dls-secondary">
              {t("toon_factory.assistant_no_conversations")}
            </p>
          ) : null}
        </div>
      ) : null}
      <div
        className="min-h-0 flex-1 space-y-3 overflow-y-auto py-3"
        aria-live="polite"
        data-testid="toon-assistant-transcript"
      >
        {snapshot?.conversation.state === "deleting" ? (
          <div role="status" className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-[10px] text-amber-700 dark:text-amber-300" data-testid="toon-assistant-cleanup-pending">
            <strong className="block">{t("toon_factory.assistant_deleting")}</strong>
            <p className="mt-1">{t("toon_factory.assistant_cleanup_pending")}</p>
            {snapshot.conversation.cleanup?.lastError ? <p className="mt-1">{snapshot.conversation.cleanup.lastError}</p> : null}
            <button type="button" disabled={busy || props.readOnly} onClick={() => void remove(snapshot.conversation)} className="mt-2 rounded border border-amber-500/40 px-2 py-1 disabled:opacity-40">{t("toon_factory.assistant_cleanup_retry")}</button>
          </div>
        ) : null}
        {(snapshot?.remoteContinueWarnings ?? []).map((warning) => (
          <div key={warning.turnId} role="alert" className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-[10px] text-amber-700 dark:text-amber-300" data-testid="toon-assistant-remote-warning">
            <strong className="block">{t("toon_factory.assistant_remote_continue_title")}</strong>
            <p className="mt-1">{t("toon_factory.assistant_remote_continue_warning")}</p>
            <button type="button" disabled={busy || props.readOnly || !conversationId} onClick={() => conversationId && void props.client.acknowledgeToonAssistantRemoteWarning(props.workspaceId, props.projectId, conversationId, { turnId: warning.turnId }).then(() => loadSnapshot())} className="mt-2 rounded border border-amber-500/40 px-2 py-1 disabled:opacity-40">
              {t("toon_factory.assistant_remote_continue_acknowledge")}
            </button>
          </div>
        ))}
        {snapshot && (snapshot.branches?.length ?? 0) > 1 ? (
          <div className="rounded-xl border border-dls-border bg-dls-hover/40 p-2 text-[9px] text-dls-secondary" data-testid="toon-assistant-branches">
            <strong className="text-dls-text">{t("toon_factory.assistant_branches")}</strong>
            {(snapshot.branches ?? []).map((branch) => <div key={branch.id} className="mt-1 flex items-center justify-between gap-2"><span>{branch.active ? t("toon_factory.assistant_branch_active") : t("toon_factory.assistant_branch_archived")} · {branch.turnIds.length}</span>{branch.remoteMayContinue ? <span className="text-amber-600">{t("toon_factory.assistant_branch_remote")}</span> : null}</div>)}
          </div>
        ) : null}
        {!snapshot?.messages.length ? (
          <div className="rounded-xl border border-dashed border-dls-border p-4 text-center text-[11px] leading-5 text-dls-secondary">
            {t("toon_factory.assistant_empty_hint")}
          </div>
        ) : null}
        {snapshot?.messages.map((message) => (
          <MessageCard
            key={message.id}
            message={message}
            readOnly={Boolean(props.readOnly || busy)}
            onPrepareGeneration={prepareGeneration}
            onEdit={() => void send(message)}
          />
        ))}
        {snapshot?.canvasProposals.map((record) => (
          <div
            key={record.proposal.id}
            className="rounded-xl border border-dls-accent/30 bg-dls-accent/5 p-3 text-[10px]"
            data-testid="toon-assistant-canvas-proposal"
          >
            <strong className="block">
              {t("toon_factory.assistant_canvas_proposal")}
            </strong>
            <p className="mt-1">{record.proposal.summary}</p>
            <p className="mt-1 text-dls-secondary">
              {record.proposal.affected
                .map((item) => `${item.kind}:${item.id}`)
                .join(", ")}{" "}
              · {record.state}
            </p>
            {record.state === "proposed" ? (
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={busy || props.readOnly}
                  title={
                    props.readOnly
                      ? t("toon_factory.lease_read_only")
                      : busy
                        ? t("toon_factory.assistant_busy_reason")
                        : undefined
                  }
                  onClick={() =>
                    void decideCanvasProposal(record.proposal, "approve")
                  }
                  className="rounded bg-dls-accent px-2 py-1 text-white disabled:opacity-40"
                >
                  {t("toon_factory.assistant_apply")}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  title={
                    busy ? t("toon_factory.assistant_busy_reason") : undefined
                  }
                  onClick={() =>
                    void decideCanvasProposal(record.proposal, "deny")
                  }
                  className="rounded border border-dls-border px-2 py-1 disabled:opacity-40"
                >
                  {t("toon_factory.assistant_deny")}
                </button>
              </div>
            ) : null}
            {record.error ? (
              <p className="mt-1 text-destructive">{record.error.message}</p>
            ) : null}
          </div>
        ))}
        {snapshot?.interactions
          .filter((item) => item.state === "pending")
          .map((item) => (
            <div
              key={item.id}
              role="group"
              aria-label={t("toon_factory.assistant_human_action", {
                kind: item.kind,
              })}
              className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-[10px]"
            >
              <strong className="block">
                {t("toon_factory.assistant_human_action", { kind: item.kind })}
              </strong>
              <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-[9px] text-dls-secondary">
                {JSON.stringify(item.payload, null, 2)}
              </pre>
              {item.kind === "permission" ? (
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    autoFocus
                    onClick={() =>
                      void props.client
                        .replyToonAssistantInteraction(
                          props.workspaceId,
                          props.projectId,
                          item.conversationId,
                          item.id,
                          "allow_once",
                        )
                        .then(() => loadSnapshot())
                    }
                    className="rounded bg-dls-accent px-2 py-1 text-white"
                  >
                    {t("toon_factory.assistant_allow_once")}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void props.client
                        .replyToonAssistantInteraction(
                          props.workspaceId,
                          props.projectId,
                          item.conversationId,
                          item.id,
                          "reject",
                        )
                        .then(() => loadSnapshot())
                    }
                    className="rounded border border-dls-border px-2 py-1"
                  >
                    {t("toon_factory.assistant_deny")}
                  </button>
                </div>
              ) : item.kind === "question" ? (
                <button
                  type="button"
                  autoFocus
                  onClick={() => {
                    const answer = window.prompt(
                      t("toon_factory.assistant_answer"),
                    );
                    if (answer)
                      void props.client
                        .replyToonAssistantInteraction(
                          props.workspaceId,
                          props.projectId,
                          item.conversationId,
                          item.id,
                          [[answer]],
                        )
                        .then(() => loadSnapshot());
                  }}
                  className="mt-2 rounded bg-dls-accent px-2 py-1 text-white"
                >
                  {t("toon_factory.assistant_answer")}
                </button>
              ) : (
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    disabled={
                      busy ||
                      props.readOnly ||
                      item.kind !== "compute-authorization" ||
                      !generationFromInteraction(item)
                    }
                    title={
                      props.readOnly
                        ? t("toon_factory.lease_read_only")
                        : undefined
                    }
                    onClick={() => void authorizeGeneration(item)}
                    className="rounded bg-dls-accent px-2 py-1 text-white disabled:opacity-40"
                  >
                    {item.kind === "compute-authorization"
                      ? t("toon_factory.authorize_compute")
                      : t("toon_factory.assistant_apply")}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void denyProtectedInteraction(item)}
                    className="rounded border border-dls-border px-2 py-1"
                  >
                    {t("toon_factory.assistant_deny")}
                  </button>
                </div>
              )}
            </div>
          ))}
        {Object.entries(generationJobs).map(([generationId, record]) => {
          const proposalInteraction = generationInteraction(generationId);
          const canSubmit =
            record.authorization?.state === "valid" &&
            record.authorization.planFingerprint === record.generation.requestHash &&
            record.authorization.requestId === record.generation.requestId &&
            !record.job;
          const canReauthorize =
            (!record.authorization ||
              record.authorization.state === "expired") &&
            !record.job &&
            proposalInteraction;
          return (
            <div
              key={generationId}
              className="rounded-xl border border-dls-border p-3 text-[10px]"
              data-testid="toon-assistant-generation-status"
            >
              <strong>{generationId}</strong>
              <span className="ml-2 text-dls-secondary">
                {record.job?.status ?? record.generation.status}
              </span>
              {record.authorization ? (
                <span
                  className="ml-2 text-dls-secondary"
                  data-testid="toon-generation-authorization-state"
                >
                  {record.authorization.state}
                </span>
              ) : null}
              {canSubmit ? (
                <pre data-testid="toon-generation-authorized-plan-summary" className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded border border-dls-border p-2 text-dls-secondary">
                  {JSON.stringify(record.authorization!.planSummary, null, 2)}
                </pre>
              ) : null}
              {canSubmit ? (
                <button
                  type="button"
                  disabled={busy || props.readOnly}
                  title={
                    props.readOnly
                      ? t("toon_factory.lease_read_only")
                      : undefined
                  }
                  onClick={() => void submitGeneration(generationId)}
                  className="ml-2 rounded border border-dls-border px-2 py-1 disabled:opacity-40"
                >
                  {t("toon_factory.submit_generation")}
                </button>
              ) : null}
              {canReauthorize ? (
                <button
                  type="button"
                  data-testid="toon-generation-reauthorize"
                  disabled={busy || props.readOnly}
                  title={
                    props.readOnly
                      ? t("toon_factory.lease_read_only")
                      : undefined
                  }
                  onClick={() => void authorizeGeneration(proposalInteraction)}
                  className="ml-2 rounded border border-dls-border px-2 py-1 disabled:opacity-40"
                >
                  {t("toon_factory.authorize_batch")}
                </button>
              ) : null}
              {record.job?.candidates
                .filter((candidate) => candidate.status === "awaiting-review")
                .map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    disabled={props.readOnly}
                    title={
                      props.readOnly
                        ? t("toon_factory.lease_read_only")
                        : undefined
                    }
                    onClick={() =>
                      void props.client
                        .adoptToonWorkspaceGenerationCandidate(
                          props.workspaceId,
                          props.projectId,
                          record.job!.id,
                          {
                            operationId: id("adopt-generation"),
                            adoptionId: id("adoption"),
                            candidateId: candidate.id,
                            episodeId: record.generation.episodeId,
                            workflowRecordId: record.generation.workflowRecordId,
                          },
                        )
                        .then((next) =>
                          setGenerationJobs((current) => ({
                            ...current,
                            [generationId]: { ...record, job: next.job },
                          })),
                        )
                    }
                    className="ml-2 rounded bg-dls-accent px-2 py-1 text-white disabled:opacity-40"
                  >
                    {t("toon_factory.adopt_candidate")}
                  </button>
                ))}
            </div>
          );
        })}
        {snapshot?.subagents.map((agent) => (
          <div
            key={agent.sessionId}
            className="rounded-xl border border-dls-border p-2 text-[10px]"
          >
            <Bot className="mr-1 inline size-3" />
            Subagent {agent.state}
          </div>
        ))}
        {busy && !snapshot?.activeTurnId ? (
          <div className="flex items-center gap-2 text-[10px] text-dls-secondary">
            <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" />
            {t("toon_factory.assistant_sending")}
          </div>
        ) : null}
        {replacementPending ? (
          <div className="flex items-center gap-2 text-[10px] text-dls-secondary" role="status">
            <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none" />
            {t("toon_factory.assistant_replacement_pending")}
          </div>
        ) : null}
      </div>
      {error ? (
        <p
          role="alert"
          className="mb-2 rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-[10px] text-destructive"
        >
          {error}
        </p>
      ) : null}
      {completionOpen && completions.length ? (
        <div
          className="mb-2 max-h-40 overflow-auto rounded-xl border border-dls-border bg-background p-1"
          role="listbox"
        >
          {completions.map((item) => (
            <div
              key={`${item.kind}:${item.id}`}
              className="flex items-center gap-1"
            >
              <button
                type="button"
                onClick={() => {
                  const mention = {
                    kind: item.kind,
                    id: item.id,
                    label: item.label,
                    ...(item.revision ? { revision: item.revision } : {}),
                  };
                  setMentions((current) => [
                    ...current.filter(
                      (entry) =>
                        entry.kind !== mention.kind || entry.id !== mention.id,
                    ),
                    mention,
                  ]);
                  setDraft(
                    (value) =>
                      `${value.replace(/@[^\s]*$/, "")}@${item.kind}:${item.id} `,
                  );
                  setCompletionOpen(false);
                }}
                className="min-w-0 flex-1 truncate rounded-lg px-2 py-1.5 text-left text-[10px] hover:bg-dls-hover"
              >
                @{item.kind} {item.label}
              </button>
              {item.kind !== "node" && item.revision && item.mimeType ? (
                <button
                  type="button"
                  onClick={() => {
                    const kind =
                      item.kind === "document" ? "document" : "asset";
                    setAttachments((current) => [
                      ...current.filter(
                        (entry) =>
                          entry.kind !== kind || entry.targetId !== item.id,
                      ),
                      {
                        id: id("attachment"),
                        kind,
                        targetId: item.id,
                        revision: item.revision!,
                        label: item.label,
                        mimeType: item.mimeType!,
                      },
                    ]);
                    setCompletionOpen(false);
                  }}
                  className="rounded border border-dls-border px-2 py-1 text-[9px]"
                >
                  Attach
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {attachments.length || mentions.length ? (
        <div className="mb-2 flex flex-wrap gap-1">
          {attachments.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() =>
                setAttachments((current) =>
                  current.filter((entry) => entry.id !== item.id),
                )
              }
              className="rounded-full bg-dls-hover px-2 py-1 text-[9px]"
            >
              {item.label} ×
            </button>
          ))}
          {mentions.map((item) => (
            <button
              key={`${item.kind}:${item.id}`}
              type="button"
              onClick={() =>
                setMentions((current) =>
                  current.filter(
                    (entry) => entry.kind !== item.kind || entry.id !== item.id,
                  ),
                )
              }
              className="rounded-full bg-dls-accent/10 px-2 py-1 text-[9px] text-dls-accent"
            >
              @{item.label} ×
            </button>
          ))}
        </div>
      ) : null}
      <div className="rounded-xl border border-dls-border bg-[var(--app-list-bg)] p-2 focus-within:border-dls-accent/50">
        <textarea
          ref={composerRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder={t("toon_factory.assistant_message_placeholder")}
          aria-label={t("toon_factory.assistant_message_placeholder")}
          disabled={snapshot?.conversation.state === "deleting"}
          className="max-h-32 min-h-16 w-full resize-none bg-transparent text-xs leading-5 outline-none"
        />
        <div className="flex items-center gap-1 border-t border-dls-border pt-2">
          <button
            type="button"
            title="Attach an existing project node or asset"
            onClick={() => void findCompletions()}
            className="rounded p-1.5 text-dls-secondary hover:bg-dls-hover"
          >
            <Paperclip className="size-3.5" />
          </button>
          <button
            type="button"
            title={
              props.readOnly
                ? t("toon_factory.lease_read_only")
                : "Upload a project asset attachment"
            }
            disabled={busy || props.readOnly}
            onClick={() => attachmentInputRef.current?.click()}
            className="rounded p-1.5 text-[9px] text-dls-secondary hover:bg-dls-hover disabled:opacity-40"
          >
            Upload
          </button>
          <input
            ref={attachmentInputRef}
            hidden
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm,audio/wav,audio/mpeg,audio/ogg,text/plain,.md"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void uploadAttachment(file);
              event.currentTarget.value = "";
            }}
          />
          <label className="relative flex min-w-0 flex-1 items-center text-[9px] text-dls-secondary">
            <select
              value={model ? modelValue(model) : ""}
              disabled={Boolean(conversationId)}
              aria-describedby={
                conversationId ? "toon-assistant-model-immutable" : undefined
              }
              title={
                conversationId
                  ? t("toon_factory.assistant_model_new_conversation")
                  : undefined
              }
              onChange={(event) => {
                const [providerID, modelID] =
                  event.target.value.split("\u0000");
                setModel(
                  providerID && modelID
                    ? { kind: "text", providerID, modelID }
                    : null,
                );
              }}
              className="h-7 min-w-0 max-w-full appearance-none truncate rounded-lg border border-dls-border bg-background pl-2 pr-6 text-[9px] disabled:opacity-60"
            >
              <option value="">Select text model</option>
              {conversationModel?.kind === "text" &&
              !props.textModels.some(
                (item) => modelValue(item) === modelValue(conversationModel),
              ) ? (
                <option value={modelValue(conversationModel)}>
                  {conversationModel.providerID} / {conversationModel.modelID}
                </option>
              ) : null}
              {props.textModels.map((item) => (
                <option key={modelValue(item)} value={modelValue(item)}>
                  {item.providerName} / {item.modelName}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none -ml-5 size-3" />
          </label>
          {conversationId ? (
            <span id="toon-assistant-model-immutable" className="sr-only">
              {t("toon_factory.assistant_model_new_conversation")}
            </span>
          ) : null}
          {snapshot?.activeTurnId ? (
            <button
              type="button"
              title="Stop turn"
              onClick={() =>
                void props.client
                  .stopToonAssistantTurn(
                    props.workspaceId,
                    props.projectId,
                    snapshot.conversation.id,
                    { turnId: snapshot.activeTurnId! },
                  )
                  .then(() => loadSnapshot())
              }
              className="rounded-full bg-destructive p-2 text-white"
            >
              <Square className="size-3" />
            </button>
          ) : (
            <button
              type="button"
              disabled={props.readOnly || snapshot?.conversation.state === "deleting" || !draft.trim() || !model || busy}
              title={
                props.readOnly ? t("toon_factory.lease_read_only") : "Send"
              }
              onClick={() => void send()}
              className="rounded-full bg-dls-accent p-2 text-white disabled:opacity-40"
            >
              <Send className="size-3" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function MessageCard(props: {
  message: ToonAssistantMessage;
  readOnly: boolean;
  onPrepareGeneration: (
    proposal: ToonAssistantGenerationProposal,
  ) => Promise<void>;
  onEdit: () => void;
}) {
  return (
    <article
      className={cn(
        "group rounded-xl p-3 text-xs",
        props.message.role === "user"
          ? "ml-6 bg-dls-accent/10"
          : "mr-3 border border-dls-border bg-background",
      )}
      data-role={props.message.role}
    >
      <div className="mb-1 flex items-center justify-between text-[9px] font-semibold uppercase tracking-wide text-dls-secondary">
        <span>
          {props.message.role}
          {props.message.status === "streaming"
            ? " · thinking"
            : ` · ${props.message.status}`}
        </span>
        {props.message.role === "user" ? (
          <button
            type="button"
            title="Edit and resend"
            onClick={props.onEdit}
            className="opacity-0 group-hover:opacity-100 focus:opacity-100"
          >
            <Undo2 className="size-3" />
          </button>
        ) : null}
      </div>
      {props.message.parts.map((part, index) =>
        part.type === "text" ? (
          <p key={index} className="whitespace-pre-wrap leading-5">
            {part.text}
          </p>
        ) : part.type === "reasoning" ? (
          <details key={index} className="text-[10px] text-dls-secondary">
            <summary>Thinking</summary>
            <p className="mt-1 whitespace-pre-wrap">{part.text}</p>
          </details>
        ) : part.type === "tool" ? (
          <ToolPart
            key={part.id}
            part={part}
            readOnly={props.readOnly}
            onPrepareGeneration={props.onPrepareGeneration}
          />
        ) : part.type === "subagent" ? (
          <div
            key={part.sessionId}
            className="mt-2 rounded-lg border border-dls-border p-2 text-[10px]"
          >
            Subagent: {part.title} · {part.state}
          </div>
        ) : (
          <div
            key={part.proposalId}
            className="mt-2 rounded-lg border border-dls-accent/30 p-2 text-[10px]"
          >
            Canvas proposal: {part.summary} · {part.state}
          </div>
        ),
      )}
      {props.message.contextDiagnostics.map((diagnostic, index) => (
        <div
          key={index}
          className="mt-2 rounded bg-dls-hover px-2 py-1 text-[9px] text-dls-secondary"
        >
          @{diagnostic.reference.kind}:{diagnostic.reference.id} ·{" "}
          {diagnostic.status} · {diagnostic.includedBytes}/
          {diagnostic.availableBytes} bytes
        </div>
      ))}
    </article>
  );
}

function ToolPart(props: {
  part: Extract<ToonAssistantMessage["parts"][number], { type: "tool" }>;
  readOnly: boolean;
  onPrepareGeneration: (
    proposal: ToonAssistantGenerationProposal,
  ) => Promise<void>;
}) {
  const proposal =
    props.part.name === "toon_generation_prepare" &&
    props.part.state === "completed" &&
    isGenerationProposal(props.part.result)
      ? props.part.result
      : null;
  return (
    <div className="mt-2 rounded-lg border border-dls-border p-2 text-[10px]">
      <strong>{props.part.name}</strong>
      <span className="ml-2 text-dls-secondary">
        {props.part.state} · {props.part.risk}
      </span>
      {props.part.result !== undefined ? (
        <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap">
          {JSON.stringify(props.part.result, null, 2)}
        </pre>
      ) : null}
      {proposal ? (
        <button
          type="button"
          disabled={props.readOnly}
          onClick={() => void props.onPrepareGeneration(proposal)}
          className="mt-2 rounded bg-dls-accent px-2 py-1 text-white disabled:opacity-40"
        >
          {t("toon_factory.prepare_generation")}
        </button>
      ) : null}
    </div>
  );
}

function isGenerationProposal(
  value: unknown,
): value is ToonAssistantGenerationProposal {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "id" in value &&
    "conversationId" in value &&
    "plan" in value,
  );
}
