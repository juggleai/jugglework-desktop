/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Check, ExternalLink, LoaderCircle, MessageSquareText, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { currentLocale } from "@/i18n";
import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import type { ReviewConnectionStatus, ReviewMutationInput, ReviewRun } from "@jugglework/types/reviews";
import type { ReviewPreview } from "./review-types";
import { useCloudSession } from "../settings/cloud/cloud-session-provider";

const text = (en: string, zh: string) => currentLocale() === "zh" ? zh : en;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function findingsReviewBody(run: ReviewRun): string {
  return [run.analysis?.summary, ...(run.analysis?.findings ?? []).map((finding) => `### [P${finding.priority}] ${finding.title}\n${finding.path ? `\`${finding.path}${finding.line ? `:${finding.line}` : ""}\`\n\n` : ""}${finding.body}`)].filter(Boolean).join("\n\n");
}

export function ReviewWorkflowControls(props: {
  endpoint: ResolvedWorkspaceEndpoint;
  review: ReviewPreview;
  active: boolean;
  operations?: ReviewConnectionStatus["operations"];
  onOpenSession: (sessionId: string) => void;
}) {
  const { endpoint, review } = props;
  const cloud = useCloudSession();
  const scope = `${cloud.baseUrl}:${cloud.user?.id ?? ""}:${cloud.activeOrganization?.id ?? ""}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  const currentScope = (expected?: string) => mountedRef.current && scopeRef.current === expected;
  const client = useQueryClient();
  const key = ["reviews", endpoint.baseUrl, endpoint.workspaceId, "ai-review", review.id, scope];
  const [dialog, setDialog] = useState<"ai" | "publish" | null>(null);
  const [model, setModel] = useState("");
  const [body, setBody] = useState("");
  const [publishRevision, setPublishRevision] = useState(review.headRevision);
  const [decision, setDecision] = useState<"discussion" | "COMMENT" | "APPROVE" | "REQUEST_CHANGES">("COMMENT");
  const [selected, setSelected] = useState<string[]>([]);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => { setDialog(null); setBody(""); setSelected([]); setNotice(null); setRequestId(crypto.randomUUID()); }, [scope]);
  const runs = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => endpoint.client.getReviewRun(endpoint.workspaceId, review.id, { signal }),
    enabled: props.active,
    staleTime: 10_000,
    refetchInterval: (query) => props.active && query.state.data?.run?.status === "running" ? 3_000 : false,
  });
  const dependencies = useQuery({ queryKey: ["review-models", endpoint.baseUrl, endpoint.workspaceId], queryFn: () => endpoint.client.listAutomationDependencies(endpoint.workspaceId), enabled: dialog === "ai", staleTime: 60_000 });
  const run = runs.data?.run;
  const stale = Boolean(run && run.headRevision !== review.headRevision);
  const running = run?.status === "running";
  const revisionKnown = /^[a-f0-9]{40,64}$/i.test(review.headRevision);
  useEffect(() => { setSelected(run?.analysis?.findings.map((finding) => finding.id) ?? []); }, [run?.id, run?.status]);
  const start = useMutation({
    retry: false,
    onMutate: () => ({ scope }),
    mutationFn: () => {
      const chosen = dependencies.data?.models.find((item) => `${item.providerId}/${item.modelId}` === model);
      return endpoint.client.startReviewRun(endpoint.workspaceId, review.id, { expectedHeadRevision: review.headRevision, ...(chosen ? { model: { providerID: chosen.providerId, modelID: chosen.modelId } } : {}) });
    },
    onSuccess: (data, _variables, context) => { if (currentScope(context?.scope)) client.setQueryData(key, data); },
  });
  const cancel = useMutation({ retry: false, onMutate: () => ({ scope }), mutationFn: () => endpoint.client.cancelReviewRun(endpoint.workspaceId, review.id), onSuccess: (data, _variables, context) => { if (currentScope(context?.scope)) client.setQueryData(key, data); } });
  const publish = useMutation({
    retry: false,
    onMutate: () => ({ scope }),
    mutationFn: () => endpoint.client.publishReview(endpoint.workspaceId, review.id, { requestId, expectedHeadRevision: publishRevision, body, kind: decision === "discussion" ? "comment" : "review", ...(decision === "discussion" ? {} : { event: decision }) } as ReviewMutationInput),
    onSuccess: (_data, _variables, context) => {
      if (!currentScope(context?.scope)) return;
      setDialog(null); setBody(""); setRequestId(crypto.randomUUID());
      setNotice(text("Published to GitHub.", "已发布到 GitHub。"));
      void client.invalidateQueries({ queryKey: ["reviews", endpoint.baseUrl, endpoint.workspaceId] });
    },
  });
  const fix = useMutation({
    retry: false,
    onMutate: () => ({ scope }),
    mutationFn: (findingIds: string[]) => endpoint.client.createReviewFix(endpoint.workspaceId, review.id, { runId: run!.id, findingIds, expectedHeadRevision: review.headRevision }),
    onSuccess: (data, _variables, context) => { if (currentScope(context?.scope)) { void runs.refetch(); props.onOpenSession(data.sessionId); } },
  });
  const canPublish = decision === "discussion" ? props.operations?.comment : props.operations?.submitReview;
  const error = dialog === "ai" ? start.error ?? cancel.error ?? fix.error ?? runs.error : publish.error;
  const selectBody = (value: string) => { setBody(value); setRequestId(crypto.randomUUID()); };
  const openPublish = () => { publish.reset(); setNotice(null); if (publishRevision !== review.headRevision) { setBody(""); setRequestId(crypto.randomUUID()); } setPublishRevision(review.headRevision); if (!props.operations?.submitReview && props.operations?.comment) setDecision("discussion"); setDialog("publish"); };
  return <>
    <div className="flex flex-wrap items-center justify-end gap-2" data-testid="review-workflow-controls">
      <Button variant="outline" className="h-9 rounded-full px-4 shadow-sm" onClick={() => { setDialog("ai"); start.reset(); fix.reset(); }}><Bot />{text("Review with JuggleWork", "使用 JuggleWork 审查")}{running ? <LoaderCircle className="size-3.5 animate-spin" /> : run?.status === "completed" ? ` · ${run.analysis?.findings.length ?? 0}` : ""}</Button>
      <Button className="h-9 rounded-full px-4" onClick={openPublish} disabled={!props.operations?.comment && !props.operations?.submitReview} title={!props.operations?.submitReview ? text("Check organization GitHub write permissions", "请检查组织 GitHub 连接器的写入权限") : undefined}><MessageSquareText />{text("Submit review", "提交评审")}</Button>
    </div>
    {notice ? <span role="status" className="text-xs text-green-11">{notice}</span> : null}
    <Dialog open={dialog !== null} onOpenChange={(open) => { if (!open && !publish.isPending) setDialog(null); }}>
      <DialogContent className="flex max-h-[88vh] flex-col overflow-hidden sm:max-w-[760px]">
        <DialogTitle>{dialog === "ai" ? text("AI code review", "AI 代码审查") : text("Submit to GitHub", "提交评审到 GitHub")}</DialogTitle>
        <DialogDescription>{review.owner}/{review.repository} #{review.number} · {(dialog === "publish" ? publishRevision : review.headRevision).slice(0, 8)}</DialogDescription>
        <div className="min-h-0 space-y-4 overflow-y-auto pr-1">
          {dialog === "ai" ? <>
            <p className="text-sm text-dls-secondary">{text("Findings stay private until you explicitly publish them. AI may miss issues; verify each finding.", "AI 发现仅保存在应用内，发布前请逐项核实。AI 可能遗漏问题。")}</p>
            {stale ? <p role="alert" className="rounded-xl bg-amber-3 p-3 text-sm text-amber-11">{text("These findings belong to an older revision. Run a new review before publishing or fixing.", "这些发现来自旧版本，请重新审查后再发布或创建修复任务。")}</p> : null}
            {run?.partial ? <p className="text-sm text-amber-11">{text("Review coverage is partial: large or binary files may be omitted.", "本次审查范围不完整：大文件、二进制文件或部分补丁未纳入分析。")}</p> : null}
            {!running ? <div className="flex flex-wrap items-center gap-2">
              <select aria-label={text("Review model", "审查模型")} className="h-9 min-w-0 max-w-full rounded-lg border border-dls-border bg-background px-2 text-sm" value={model} onChange={(event) => setModel(event.target.value)}>
                <option value="">{text("Workspace default model", "工作区默认模型")}</option>
                {dependencies.data?.models.map((item) => <option key={`${item.providerId}/${item.modelId}`} value={`${item.providerId}/${item.modelId}`}>{item.providerName} / {item.modelName}</option>)}
              </select>
              <Button onClick={() => start.mutate()} disabled={start.isPending || !revisionKnown}>{start.isPending ? <LoaderCircle className="animate-spin" /> : <Bot />}{run ? text("Review again", "重新审查") : text("Start review", "开始审查")}</Button>
            </div> : <div className="flex items-center gap-3 rounded-xl bg-dls-hover p-4"><LoaderCircle className="size-4 animate-spin" /><span className="flex-1 text-sm">{text("Reviewing this revision…", "正在审查当前版本…")}</span><Button variant="outline" onClick={() => cancel.mutate()} disabled={cancel.isPending}>{text("Cancel", "取消审查")}</Button></div>}
            {dependencies.error ? <p className="text-sm text-amber-11">{text("Could not load models. The workspace default is still available.", "模型列表加载失败，仍可使用工作区默认模型。")}</p> : null}
            {run?.status === "failed" || run?.status === "cancelled" ? <p role="status" className="text-sm text-dls-secondary">{run.error}</p> : null}
            {run?.analysis ? <>
              <p className="whitespace-pre-wrap text-sm leading-6">{run.analysis.summary}</p>
              {!run.analysis.findings.length ? <p className="rounded-xl border border-dls-border p-4 text-sm">{text("No actionable defects were found in the reviewed context.", "在本次审查范围内未发现明确可操作的缺陷。")}</p> : null}
              {run.analysis.findings.map((finding) => <article key={finding.id} className="rounded-xl border border-dls-border p-4" data-testid={`review-finding:${finding.id}`}>
                <label className="flex items-start gap-3"><input type="checkbox" checked={selected.includes(finding.id)} onChange={(event) => setSelected((value) => event.target.checked ? [...value, finding.id] : value.filter((id) => id !== finding.id))} className="mt-1" /><span className="text-sm font-semibold">[P{finding.priority}] {finding.title}</span></label>
                {finding.path ? <p className="mt-2 break-all font-mono text-xs text-dls-secondary">{finding.path}{finding.line ? `:${finding.line}` : ""}</p> : null}
                <p className="mt-2 whitespace-pre-wrap text-sm leading-6">{finding.body}</p>
                <Button variant="outline" className="mt-3" disabled={stale || fix.isPending || running} onClick={() => fix.mutate([finding.id])}><Wrench />{text("Create fix task", "创建修复任务")}</Button>
              </article>)}
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" disabled={!selected.length || stale || fix.isPending || running} onClick={() => fix.mutate(selected)}>{fix.isPending ? <LoaderCircle className="animate-spin" /> : <Wrench />}{text("Fix selected", "修复所选问题")}</Button>
                <Button disabled={stale || running || !props.operations?.submitReview} onClick={() => { selectBody(findingsReviewBody(run)); setDecision("COMMENT"); openPublish(); }}>{text("Use in review…", "用于提交评审…")}</Button>
              </div>
            </> : null}
            {run?.sessionId ? <Button variant="ghost" onClick={() => props.onOpenSession(run.sessionId!)}><ExternalLink />{text("Open review task", "查看审查任务")}</Button> : null}
            {run?.fixSessionId ? <Button variant="ghost" onClick={() => props.onOpenSession(run.fixSessionId!)}><ExternalLink />{text("Open fix task", "查看修复任务")}</Button> : null}
          </> : <>
            {publishRevision !== review.headRevision ? <p role="alert" className="rounded-xl bg-amber-3 p-3 text-sm text-amber-11">{text("The PR changed while you were writing. Close this dialog and review the latest changes before publishing.", "填写期间 PR 已更新，请关闭弹窗并检查最新代码后再提交。")}</p> : null}
            <p className="text-sm text-dls-secondary">{text("This action publishes the text below to GitHub using your organization's connector.", "此操作会通过组织连接器，将下方内容发布到 GitHub。")}</p>
            <select aria-label={text("Review decision", "评审决定")} value={decision} onChange={(event) => { setDecision(event.target.value as typeof decision); setRequestId(crypto.randomUUID()); publish.reset(); }} className="h-10 w-full rounded-xl border border-dls-border bg-background px-3 text-sm" disabled={publish.isPending}>
              <option value="COMMENT" disabled={!props.operations?.submitReview}>{text("Comment", "评审评论")}</option>
              <option value="APPROVE" disabled={!props.operations?.submitReview}>{text("Approve", "批准")}</option>
              <option value="REQUEST_CHANGES" disabled={!props.operations?.submitReview}>{text("Request changes", "请求修改")}</option>
              <option value="discussion" disabled={!props.operations?.comment}>{text("Discussion comment", "普通讨论评论")}</option>
            </select>
            <textarea aria-label={text("Review comment", "评审内容")} className="min-h-52 w-full resize-y rounded-xl border border-dls-border bg-background p-3 text-sm leading-6 outline-none focus:border-dls-accent" placeholder={text("Write your review…", "填写评审内容…")} value={body} onChange={(event) => { selectBody(event.target.value); publish.reset(); }} disabled={publish.isPending} maxLength={60_000} />
            <Button className="w-full" disabled={publish.isPending || publishRevision !== review.headRevision || !canPublish || !revisionKnown || (decision !== "APPROVE" && !body.trim())} onClick={() => publish.mutate()}>{publish.isPending ? <LoaderCircle className="animate-spin" /> : <Check />}{text("Publish to GitHub", "确认发布到 GitHub")}</Button>
          </>}
          {error ? <p role="alert" className="whitespace-pre-wrap text-sm text-red-11">{message(error)}</p> : null}
        </div>
      </DialogContent>
    </Dialog>
  </>;
}
