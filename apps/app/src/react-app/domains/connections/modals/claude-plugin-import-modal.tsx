/** @jsxImportSource react */
import { useReducer } from "react";
import { Download, Loader2, Search } from "lucide-react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { TextInput } from "../../../design-system/text-input";
import type { JuggleWorkClaudePluginPreview } from "../../../../app/lib/jugglework-server";
import type { CloudPluginMutationResult } from "../../settings/state/extensions-store";

export type ClaudePluginImportModalProps = {
  open: boolean;
  onClose: () => void;
  onPreview: (url: string) => Promise<JuggleWorkClaudePluginPreview>;
  onInstall: (url: string) => Promise<CloudPluginMutationResult>;
  /** Called after a successful install so the host view can refresh. */
  onInstalled?: () => void;
};

type ModalState = {
  url: string;
  preview: JuggleWorkClaudePluginPreview | null;
  /** URL the current preview was generated from; install always targets this. */
  previewedUrl: string | null;
  previewing: boolean;
  installing: boolean;
  error: string | null;
  result: CloudPluginMutationResult | null;
};

const initialState: ModalState = {
  url: "",
  preview: null,
  previewedUrl: null,
  previewing: false,
  installing: false,
  error: null,
  result: null,
};

type ModalAction =
  | Partial<ModalState>
  | "reset"
  | { kind: "preview-success"; url: string; preview: JuggleWorkClaudePluginPreview };

function reducer(state: ModalState, action: ModalAction): ModalState {
  if (action === "reset") return initialState;
  if ("kind" in action) {
    // Ignore preview responses for a URL the user has since edited away from.
    if (state.url.trim() !== action.url) return { ...state, previewing: false };
    return { ...state, previewing: false, preview: action.preview, previewedUrl: action.url };
  }
  return { ...state, ...action };
}

const COMPONENT_LABELS: Record<string, { singular: string; plural: string }> = {
  mcp: { singular: "MCP server", plural: "MCP servers" },
  skill: { singular: "Skill", plural: "Skills" },
  command: { singular: "Command", plural: "Commands" },
  agent: { singular: "Agent", plural: "Agents" },
};

type ClaudePluginImportFeedback = {
  tone: "warning" | "error";
  title: string;
  details: string[];
};

const OUTCOME_ACTIONS: Record<string, string> = {
  needs_signin: "Sign in to the required service, then retry installation.",
  needs_admin_setup: "Ask an organization administrator to configure the required service, then retry.",
  unsupported: "This component is not supported in the current workspace.",
  failed: "Resolve the component error, then retry installation.",
};

/**
 * 判断 Claude 插件安装结果是否可以作为完整成功关闭弹窗。
 * @param result 插件安装的结构化变更结果
 */
export function isClaudePluginImportComplete(result: CloudPluginMutationResult): boolean {
  const outcomes = result.outcomes?.length ? result.outcomes : result.files;
  return result.ok
    && result.status === "installed"
    && result.warnings.length === 0
    && !result.conflicts?.length
    && !outcomes.some((outcome) => (
      outcome.outcome === "needs_signin"
      || outcome.outcome === "needs_admin_setup"
      || outcome.outcome === "unsupported"
      || outcome.outcome === "failed"
    ));
}

/**
 * 将 Claude 插件安装的结构化结果转换为可执行的用户提示。
 * @param result 插件安装的结构化变更结果
 */
export function resolveClaudePluginImportFeedback(
  result: CloudPluginMutationResult,
): ClaudePluginImportFeedback | null {
  if (isClaudePluginImportComplete(result)) return null;

  const outcomes = result.outcomes?.length ? result.outcomes : result.files;
  const needsAdminSetup = outcomes.some((outcome) => outcome.outcome === "needs_admin_setup");
  const needsSignin = outcomes.some((outcome) => outcome.outcome === "needs_signin");
  const hasConflicts = Boolean(result.conflicts?.length);
  const tone = result.status === "failed" || result.status === "repair_required" || hasConflicts
    ? "error"
    : "warning";
  const title = result.status === "repair_required"
    ? "Repair required"
    : hasConflicts
      ? "Resolve conflicts before retrying"
      : result.status === "failed"
        ? "Installation failed"
        : result.status === "partial"
          ? "Installation partially completed"
          : needsAdminSetup
            ? "Administrator setup required"
            : needsSignin
              ? "Sign-in required"
              : result.warnings.length > 0
                ? "Review installation warnings"
                : "Installation incomplete";

  const details = [
    result.message,
    ...(result.conflicts?.map((conflict) => conflict.message) ?? []),
    ...outcomes.flatMap((outcome) => {
      const action = outcome.outcome ? OUTCOME_ACTIONS[outcome.outcome] : undefined;
      if (!outcome.errorMessage && !action) return [];
      const detail = outcome.errorMessage ?? action;
      return [`${outcome.title}: ${detail}${outcome.errorMessage && action ? ` ${action}` : ""}`];
    }),
    ...result.warnings,
  ].filter((detail, index, all) => Boolean(detail) && all.indexOf(detail) === index);

  return { tone, title, details };
}

export function ClaudePluginImportModal(props: ClaudePluginImportModalProps) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const handleClose = () => {
    if (state.previewing || state.installing) return;
    dispatch("reset");
    props.onClose();
  };

  const handlePreview = async () => {
    const url = state.url.trim();
    if (!url) {
      dispatch({ error: "Enter a GitHub repository URL." });
      return;
    }
    dispatch({ previewing: true, error: null, result: null, preview: null, previewedUrl: null });
    try {
      const preview = await props.onPreview(url);
      dispatch({ kind: "preview-success", url, preview });
    } catch (error) {
      dispatch({
        previewing: false,
        error: error instanceof Error ? error.message : "Failed to load plugin preview",
      });
    }
  };

  const handleInstall = async () => {
    // Install exactly what was previewed — never a URL edited after preview.
    const url = state.previewedUrl;
    if (!url || state.installing) return;
    dispatch({ installing: true, error: null, result: null });
    try {
      const result = await props.onInstall(url);
      if (!isClaudePluginImportComplete(result)) {
        dispatch({ installing: false, result });
        return;
      }
    } catch (error) {
      dispatch({
        installing: false,
        error: error instanceof Error ? error.message : "Failed to install plugin",
      });
      return;
    }
    dispatch("reset");
    props.onInstalled?.();
    props.onClose();
  };

  const preview = state.preview;
  const groups = preview
    ? (["mcp", "skill", "command", "agent"] as const)
        .map((type) => ({
          type,
          items: preview.components.filter((component) => component.type === type),
        }))
        .filter((group) => group.items.length > 0)
    : [];

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
    >
      <DialogContent className="flex max-h-[90vh] min-h-0 w-full max-w-lg flex-col overflow-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Install a plugin from GitHub</DialogTitle>
          <DialogDescription>
            Works with Claude Code plugins: a repo with .claude-plugin/plugin.json bundling an MCP
            server, skills, and commands.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <TextInput
                label="GitHub repository"
                placeholder="https://github.com/slackapi/slack-mcp-plugin"
                value={state.url}
                onChange={(event) =>
                  dispatch({ url: event.currentTarget.value, preview: null, previewedUrl: null, result: null })
                }
              />
            </div>
            <Button
              variant="outline"
              onClick={() => void handlePreview()}
              disabled={state.previewing || state.installing}
            >
              {state.previewing ? (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              ) : (
                <Search data-icon="inline-start" />
              )}
              Preview
            </Button>
          </div>

          {state.preview ? (
            <div className="space-y-3 rounded-xl border border-dls-border bg-dls-hover/40 p-4">
              <div>
                <div className="text-sm font-semibold text-dls-text">
                  {state.preview.name}
                  {state.preview.version ? (
                    <span className="ml-2 text-xs font-normal text-dls-secondary">v{state.preview.version}</span>
                  ) : null}
                </div>
                {state.preview.description ? (
                  <div className="mt-0.5 text-xs text-dls-secondary">{state.preview.description}</div>
                ) : null}
                <div className="mt-1 text-[11px] text-dls-secondary">
                  {state.preview.source.owner}/{state.preview.source.repo} @ {state.preview.source.ref}
                  {state.preview.source.dir ? ` · ${state.preview.source.dir}` : ""}
                </div>
              </div>

              <div>
                <div className="mb-1.5 text-xs font-medium text-dls-text">Will install</div>
                <div className="space-y-2">
                  {groups.map((group) => (
                    <div key={group.type}>
                      <div className="text-[11px] font-medium uppercase tracking-wide text-dls-secondary">
                        {group.items.length === 1
                          ? `1 ${COMPONENT_LABELS[group.type]?.singular}`
                          : `${group.items.length} ${COMPONENT_LABELS[group.type]?.plural}`}
                      </div>
                      <ul className="mt-0.5 space-y-0.5">
                        {group.items.map((item) => (
                          <li key={`${group.type}:${item.name}`} className="text-xs text-dls-text">
                            <span className="font-medium">{item.name}</span>
                            {item.description ? (
                              <span className="text-dls-secondary"> — {item.description}</span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>

              {state.preview.warnings.length > 0 ? (
                <div className="rounded-lg border border-amber-6 bg-amber-2 px-3 py-2 text-xs text-amber-11">
                  {state.preview.warnings.map((warning) => (
                    <div key={warning}>{warning}</div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {state.error ? (
            <div className="rounded-lg border border-red-6 bg-red-2 px-3 py-2 text-xs text-red-11">
              {state.error}
            </div>
          ) : null}

          {state.result ? (() => {
            const feedback = resolveClaudePluginImportFeedback(state.result);
            if (!feedback) return null;
            const className = feedback.tone === "error"
              ? "border-red-6 bg-red-2 text-red-11"
              : "border-amber-6 bg-amber-2 text-amber-11";
            return (
              <div className={`rounded-lg border px-3 py-2 text-xs ${className}`} role="status">
                <div className="font-semibold">{feedback.title}</div>
                <ul className="mt-1 list-disc space-y-1 pl-4">
                  {feedback.details.map((detail) => <li key={detail}>{detail}</li>)}
                </ul>
              </div>
            );
          })() : null}
        </div>

        <DialogFooter className="shrink-0">
          <DialogClose
            render={<Button variant="outline" disabled={state.previewing || state.installing} />}
            disabled={state.previewing || state.installing}
          >
            Cancel
          </DialogClose>
          <Button
            onClick={() => void handleInstall()}
            disabled={!state.preview || state.previewing || state.installing}
          >
            {state.installing ? (
              <Loader2 data-icon="inline-start" className="animate-spin" />
            ) : (
              <Download data-icon="inline-start" />
            )}
            {state.result ? "Retry install" : "Install"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
