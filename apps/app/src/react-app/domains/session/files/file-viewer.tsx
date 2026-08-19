/** @jsxImportSource react */
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { JuggleWorkServerClient } from "@/app/lib/jugglework-server";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { t } from "../../../../i18n";
import {
  HTMLPreview,
  ImagePreview,
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
    mutationFn: async (input: { content: string; baseUpdatedAt: number | null }) =>
      saveWorkspaceTextFile(client, workspaceId, path, input.content, input.baseUpdatedAt),
    onSuccess: (updatedAt, input) => {
      queryClient.setQueryData<LoadedFile>(queryKey, (current) => (
        current ? { ...current, text: input.content, updatedAt, size: new TextEncoder().encode(input.content).length } : current
      ));
      setDraft(sessionId, path, null);
      toast.success(t("session_files.saved"));
    },
    onError: (cause) => {
      // TIPS: 保存冲突后草稿仍带着过期的 baseUpdatedAt，再点保存只会继续 409，
      // 因此把「重新加载」直接挂在冲突提示上 —— 文件内容区已经没有工具栏了。
      if (cause instanceof FileAccessError && cause.kind === "conflict") {
        toast.error(describeError(cause), {
          action: {
            label: t("session_files.reload"),
            onClick: () => {
              setDraft(sessionId, path, null);
              void refetch();
            },
          },
        });

        return;
      }

      toast.error(describeError(cause));
    },
  });

  const editable = data?.presentation === "markdown" || data?.presentation === "text";
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
            onClick={() => setDraft(sessionId, path, null)}
          >
            {t("session_files.discard")}
          </Button>
          <Button
            variant="default"
            size="sm"
            disabled={isSaving}
            onClick={() => save({ content: value, baseUpdatedAt: draft?.baseUpdatedAt ?? data?.updatedAt ?? null })}
          >
            {isSaving ? t("session_files.saving") : t("session_files.save")}
          </Button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden">
        {isLoading ? <PreviewLoading /> : null}
        {isError ? <PreviewError message={describeError(error)} /> : null}
        {data && editable ? (
          <React.Suspense fallback={<PreviewLoading />}>
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
          </React.Suspense>
        ) : null}
        {data?.presentation === "image" && objectUrl ? <ImagePreview src={objectUrl} alt={name} /> : null}
        {data?.presentation === "pdf" && objectUrl ? <PdfPreview url={objectUrl} title={name} /> : null}
        {data?.presentation === "html" ? <HTMLPreview type="text" title={name} content={data.text ?? ""} /> : null}
        {data?.presentation === "binary" ? <PreviewUnavailable /> : null}
      </div>
    </div>
  );
}
