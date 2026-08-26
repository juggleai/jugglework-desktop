/** @jsxImportSource react */
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, Pencil } from "lucide-react";

import type { JuggleWorkServerClient } from "@/app/lib/jugglework-server";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { t } from "../../../../i18n";
import {
  HTMLPreview,
  ImagePreview,
  MarkdownPreview,
  PdfPreview,
  PreviewError,
  PreviewLoading,
  PreviewUnavailable,
} from "../artifacts/preview";
import { FileAccessError, loadWorkspaceFile, saveWorkspaceTextFile, type LoadedFile } from "./file-content";
import { useFilesPanelStore, type FilesPanelDraft } from "./files-panel-store";

const ArtifactTextEditor = React.lazy(() =>
  import("../artifacts/artifact-text-editor").then((module) => ({ default: module.ArtifactTextEditor })),
);

type FileViewerProps = {
  client: JuggleWorkServerClient;
  workspaceId: string;
  sessionId: string;
  path: string;
  name: string;
  draft: FilesPanelDraft | undefined;
};

function describeError(cause: unknown): string {
  if (cause instanceof FileAccessError) {
    if (cause.kind === "not_found") return t("session_files.file_missing");
    if (cause.kind === "too_large") return t("session_files.file_too_large");
    if (cause.kind === "conflict") return t("session_files.save_conflict");
  }

  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * 文件内容视图：文本可编辑保存，其余类型走只读预览
 *
 * @param client JuggleWork 服务端客户端
 * @param workspaceId 工作区 id
 * @param sessionId 会话 id
 * @param path 文件的工作区相对路径
 * @param name 文件名
 * @param draft 该文件的未保存草稿
 */
export function FileViewer({ client, workspaceId, sessionId, path, name, draft }: FileViewerProps) {
  const queryClient = useQueryClient();
  const setDraft = useFilesPanelStore((state) => state.setDraft);
  const queryKey = React.useMemo(() => ["workspace-file", workspaceId, path] as const, [path, workspaceId]);

  const { data, error, isError, isLoading, refetch } = useQuery<LoadedFile>({
    queryKey,
    queryFn: () => loadWorkspaceFile(client, workspaceId, path),
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const [objectUrl, setObjectUrl] = React.useState<string | null>(null);
  const [markdownEditing, setMarkdownEditing] = React.useState(false);
  const activePathRef = React.useRef(path);

  React.useEffect(() => {
    activePathRef.current = path;
    setMarkdownEditing(false);
  }, [path]);

  React.useEffect(() => {
    if (!data || (data.presentation !== "image" && data.presentation !== "pdf")) {
      setObjectUrl(null);

      return;
    }

    const fallbackType = data.presentation === "pdf" ? "application/pdf" : "application/octet-stream";
    const url = URL.createObjectURL(new Blob([data.bytes], { type: data.contentType ?? fallbackType }));

    setObjectUrl(url);

    return () => URL.revokeObjectURL(url);
  }, [data]);

  const { mutate: save, isPending: isSaving } = useMutation({
    mutationFn: async (input: { content: string; baseUpdatedAt: number | null; path: string }) => ({
      updatedAt: await saveWorkspaceTextFile(client, workspaceId, input.path, input.content, input.baseUpdatedAt),
      queryKey: ["workspace-file", workspaceId, input.path] as const,
    }),
    onSuccess: (result, input) => {
      queryClient.setQueryData<LoadedFile>(result.queryKey, (current) => (
        current ? { ...current, text: input.content, updatedAt: result.updatedAt, size: new TextEncoder().encode(input.content).length } : current
      ));
      setDraft(sessionId, input.path, null);
      if (activePathRef.current === input.path) setMarkdownEditing(false);
      toast.success(t("session_files.saved"));
    },
    onError: (cause, input) => {
      // TIPS: 保存冲突后草稿仍带着过期的 baseUpdatedAt，再点保存只会继续 409，
      // 因此把「重新加载」直接挂在冲突提示上 —— 文件内容区已经没有工具栏了。
      if (cause instanceof FileAccessError && cause.kind === "conflict") {
        toast.error(describeError(cause), {
          action: {
            label: t("session_files.reload"),
            onClick: () => {
              setDraft(sessionId, input.path, null);
              if (activePathRef.current === input.path) {
                void refetch();
              } else {
                void queryClient.invalidateQueries({ queryKey: ["workspace-file", workspaceId, input.path], exact: true });
              }
            },
          },
        });

        return;
      }

      toast.error(describeError(cause));
    },
  });

  const isMarkdown = data?.presentation === "markdown";
  const editable = isMarkdown || data?.presentation === "text";
  const value = draft?.content ?? data?.text ?? "";
  const dirty = editable && draft !== undefined && draft.content !== (data?.text ?? "");

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* TIPS: 内容区上方常态不放任何工具栏 —— 文件名在标签上已经有了；只有出现未保存
          修改时才浮出保存/放弃这一行，让编辑器尽量占满面板。 */}
      {editable && dirty ? (
        <div className="flex h-9 shrink-0 items-center justify-end gap-2 border-b border-border/60 px-3">
          <Button
            variant="ghost"
            size="sm"
            disabled={isSaving}
            onClick={() => {
              setDraft(sessionId, path, null);
              if (isMarkdown) setMarkdownEditing(false);
            }}
          >
            {t("session_files.discard")}
          </Button>
          <Button
            variant="default"
            size="sm"
            disabled={isSaving}
            onClick={() => save({ path, content: value, baseUpdatedAt: draft?.baseUpdatedAt ?? data?.updatedAt ?? null })}
          >
            {isSaving ? t("session_files.saving") : t("session_files.save")}
          </Button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden">
        {isLoading ? <PreviewLoading /> : null}
        {isError ? <PreviewError message={describeError(error)} /> : null}
        {data && (data.presentation === "text" || markdownEditing) ? (
          <React.Suspense fallback={<PreviewLoading />}>
            <div className="relative h-full min-h-0">
              <ArtifactTextEditor
                value={value}
                language={data.presentation === "markdown" ? "markdown" : "text"}
                onChange={(next) => {
                  if (next === (data.text ?? "")) {
                    setDraft(sessionId, path, null);

                    return;
                  }

                  setDraft(sessionId, path, { content: next, baseUpdatedAt: data.updatedAt });
                }}
              />
              {isMarkdown && !dirty ? (
                <Button
                  variant="outline"
                  size="icon-sm"
                  className="absolute right-3 top-3 z-10 bg-background/95 shadow-sm"
                  onClick={() => setMarkdownEditing(false)}
                  aria-label={t("session_files.markdown_preview")}
                  title={t("session_files.markdown_preview")}
                >
                  <Eye />
                </Button>
              ) : null}
            </div>
          </React.Suspense>
        ) : null}
        {data?.presentation === "markdown" && !markdownEditing ? (
          <div className="relative h-full min-h-0">
            <MarkdownPreview content={value} />
            <Button
              variant="outline"
              size="icon-sm"
              className="absolute right-3 top-3 z-10 bg-background/95 shadow-sm"
              onClick={() => setMarkdownEditing(true)}
              aria-label={t("common.edit")}
              title={t("common.edit")}
            >
              <Pencil />
            </Button>
          </div>
        ) : null}
        {data?.presentation === "image" && objectUrl ? <ImagePreview src={objectUrl} alt={name} /> : null}
        {data?.presentation === "pdf" && objectUrl ? <PdfPreview url={objectUrl} title={name} /> : null}
        {data?.presentation === "html" ? <HTMLPreview type="text" title={name} content={data.text ?? ""} /> : null}
        {data?.presentation === "binary" ? <PreviewUnavailable /> : null}
      </div>
    </div>
  );
}
