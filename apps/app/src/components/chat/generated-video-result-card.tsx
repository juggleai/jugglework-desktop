import * as React from "react"
import { Check, Download, Expand, LoaderCircle, Video } from "lucide-react"

import { useMessageList } from "@/components/chat/message-list-provider"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { toast } from "@/components/ui/sonner"
import { currentLocale } from "@/i18n"
import { formatFileSize } from "@/lib/utils"
import { notifyDesktopEvent } from "@/react-app/shell/desktop-notifications"
import { notifyEvent } from "@/react-app/shell/notifications"
import {
  generatedVideoJobFromOutput,
  isGeneratedVideoJobRecent,
  type GeneratedVideoJob,
} from "./generated-video-result"

const TERMINAL = new Set(["completed", "failed", "cancelled"])
const notifiedJobs = new Set<string>()

function labels() {
  const zh = currentLocale() === "zh"
  return zh ? {
    title: "视频生成",
    completed: "视频生成完成",
    failed: "视频生成失败",
    cancelled: "视频生成已取消",
    working: "视频生成中",
    download: "下载",
    expand: "放大预览",
    loading: "正在加载视频",
    unavailable: "无法加载生成的视频。",
  } : {
    title: "Video generation",
    completed: "Video generation completed",
    failed: "Video generation failed",
    cancelled: "Video generation cancelled",
    working: "Generating video",
    download: "Download",
    expand: "Expand preview",
    loading: "Loading video",
    unavailable: "Generated video is unavailable.",
  }
}

function statusLabel(job: GeneratedVideoJob) {
  const copy = labels()
  if (job.status === "completed") return copy.completed
  if (job.status === "failed") return copy.failed
  if (job.status === "cancelled") return copy.cancelled
  return copy.working
}

function downloadObjectUrl(url: string, name: string) {
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = name
  anchor.click()
}

export function GeneratedVideoResultCard({ job: initialJob }: { job: GeneratedVideoJob }) {
  const { client, workspaceId, sessionId } = useMessageList()
  const [job, setJob] = React.useState(initialJob)
  const [open, setOpen] = React.useState(false)
  const [objectUrl, setObjectUrl] = React.useState<string | null>(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const observedActiveJob = React.useRef(!TERMINAL.has(initialJob.status))
  const copy = labels()

  React.useEffect(() => {
    setJob((current) => (initialJob.revision ?? 0) >= (current.revision ?? 0) ? initialJob : current)
  }, [initialJob])

  React.useEffect(() => {
    if (!client || TERMINAL.has(job.status)) return
    let active = true
    let timer: number | null = null
    const poll = async () => {
      try {
        const response = await client.callExtensionAction({
          extensionId: "media-generation",
          action: "video_job_get",
          args: { jobId: job.id },
          context: { workspaceId },
        })
        if (!active) return
        const next = generatedVideoJobFromOutput(response, job.toolCallId)
        if (next) setJob(next)
        if (!next || !TERMINAL.has(next.status)) timer = window.setTimeout(poll, 3_000)
      } catch {
        if (active) timer = window.setTimeout(poll, 5_000)
      }
    }
    timer = window.setTimeout(poll, 1_000)
    return () => {
      active = false
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [client, job.id, job.status, job.toolCallId, workspaceId])

  React.useEffect(() => {
    if (!TERMINAL.has(job.status)) {
      observedActiveJob.current = true
      return
    }
    if (notifiedJobs.has(job.id)) return
    if (!observedActiveJob.current && !isGeneratedVideoJobRecent(job)) {
      notifiedJobs.add(job.id)
      return
    }
    notifiedJobs.add(job.id)
    const title = statusLabel(job)
    const body = job.artifact?.name ?? job.error?.message
    notifyEvent({
      kind: "system",
      severity: job.status === "completed" ? "success" : job.status === "failed" ? "error" : "info",
      title,
      ...(body ? { body } : {}),
      dedupeKey: `video-generation:${job.id}`,
    })
    if (job.status === "completed") toast.success(title, { description: body })
    else if (job.status === "failed") toast.error(title, { description: body })
    if (job.status === "completed" || job.status === "failed") {
      notifyDesktopEvent({
        type: job.status === "completed" ? "video.completed" : "video.failed",
        sessionId,
        detail: body,
      })
    }
  }, [job, sessionId])

  React.useEffect(() => {
    if (!client || !job.artifact || job.status !== "completed") return
    let active = true
    let url: string | null = null
    setLoadError(null)
    void client.downloadWorkspaceFile(workspaceId, job.artifact.path).then((download) => {
      if (!active) return
      url = URL.createObjectURL(new Blob([download.data], { type: download.contentType ?? job.artifact?.mimeType }))
      setObjectUrl(url)
    }).catch((cause) => {
      if (active) setLoadError(cause instanceof Error ? cause.message : copy.unavailable)
    })
    return () => {
      active = false
      if (url) URL.revokeObjectURL(url)
      setObjectUrl(null)
    }
  }, [client, copy.unavailable, job.artifact, job.status, workspaceId])

  const modelLabel = [job.model?.providerID, job.model?.modelID].filter(Boolean).join("/")
  const working = !TERMINAL.has(job.status)

  return (
    <div className="overflow-hidden rounded-2xl border border-border/80 bg-muted/15" data-testid="generated-video-result" data-video-job-id={job.id}>
      <div className="flex items-center justify-between gap-3 border-b border-border/70 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          {working ? <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground" /> : job.status === "completed" ? <Check className="size-4 shrink-0 text-green-10" /> : <Video className="size-4 shrink-0 text-muted-foreground" />}
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{statusLabel(job)}</div>
            <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              {modelLabel ? <span className="truncate">{modelLabel}</span> : null}
              {typeof job.progress === "number" ? <span>{Math.round(job.progress)}%</span> : null}
              {job.artifact?.bytes ? <span>{formatFileSize(job.artifact.bytes)}</span> : null}
            </div>
          </div>
        </div>
        {job.artifact && objectUrl ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => downloadObjectUrl(objectUrl, job.artifact!.name)}>
            <Download className="size-4" />{copy.download}
          </Button>
        ) : null}
      </div>

      {job.status === "completed" && job.artifact ? (
        objectUrl ? (
          <div className="group/video relative flex max-h-[28rem] items-center justify-center bg-black">
            <video src={objectUrl} controls preload="metadata" className="max-h-[28rem] w-full object-contain" />
            <Button type="button" variant="secondary" size="icon-sm" className="absolute right-3 top-3 opacity-90 shadow-md" onClick={() => setOpen(true)} aria-label={copy.expand} title={copy.expand}>
              <Expand className="size-4" />
            </Button>
          </div>
        ) : loadError ? <div className="px-4 py-6 text-sm text-destructive">{loadError}</div> : (
          <div className="flex h-44 items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-5 animate-spin" />{copy.loading}</div>
        )
      ) : job.error?.message ? <div className="px-4 py-4 text-sm text-destructive">{job.error.message}</div> : (
        <div className="px-4 py-4 text-sm text-muted-foreground">{copy.working}{typeof job.progress === "number" ? ` · ${Math.round(job.progress)}%` : ""}</div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[94vh] w-[min(94vw,80rem)] max-w-[min(94vw,80rem)] gap-0 overflow-hidden rounded-2xl bg-black p-0 sm:max-w-[min(94vw,80rem)]">
          <DialogTitle className="sr-only">{job.artifact?.name ?? copy.title}</DialogTitle>
          <div className="flex min-h-[60vh] items-center justify-center p-4">
            {objectUrl ? <video src={objectUrl} controls autoPlay preload="metadata" className="max-h-[calc(94vh-5rem)] max-w-full" /> : null}
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-white/15 bg-background px-4 py-3">
            <span className="min-w-0 truncate text-sm text-muted-foreground">{job.artifact?.path}</span>
            {objectUrl && job.artifact ? <Button type="button" size="sm" onClick={() => downloadObjectUrl(objectUrl, job.artifact!.name)}><Download className="size-4" />{copy.download}</Button> : null}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
