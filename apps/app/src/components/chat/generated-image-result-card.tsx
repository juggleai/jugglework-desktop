import * as React from "react"
import { Download, ImageIcon, LoaderCircle, Save } from "lucide-react"

import { saveFileContent } from "@/app/lib/desktop"
import { isElectronRuntime } from "@/app/utils"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog"
import { toast } from "@/components/ui/sonner"
import { t } from "@/i18n"
import { formatFileSize } from "@/lib/utils"
import { useMessageList } from "@/components/chat/message-list-provider"
import type { GeneratedImageResult } from "@/components/chat/generated-image-result"

function arrayBufferToBase64(data: ArrayBuffer) {
  const bytes = new Uint8Array(data)
  let binary = ""
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  return btoa(binary)
}

function extensionOf(name: string) {
  const extension = name.split(".").at(-1)?.trim().toLowerCase()
  return extension && /^[a-z0-9]+$/.test(extension) ? extension : "png"
}

function downloadObjectUrl(url: string, name: string) {
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = name
  anchor.click()
}

export function GeneratedImageResultCard({ result }: { result: GeneratedImageResult }) {
  const { client, workspaceId } = useMessageList()
  const [open, setOpen] = React.useState(false)
  const [data, setData] = React.useState<ArrayBuffer | null>(null)
  const [objectUrl, setObjectUrl] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    let active = true
    if (!client) {
      setError(t("session.generated_image_unavailable"))
      return
    }

    setData(null)
    setObjectUrl(null)
    setError(null)
    void client.downloadWorkspaceFile(workspaceId, result.path).then((download) => {
      if (!active) return
      setData(download.data)
      const contentType = download.contentType?.toLowerCase().startsWith("image/")
        ? download.contentType
        : result.mimeType
      const blob = new Blob([download.data], { type: contentType })
      const url = URL.createObjectURL(blob)
      setObjectUrl(url)
    }).catch((cause) => {
      if (!active) return
      setError(cause instanceof Error ? cause.message : t("session.generated_image_unavailable"))
    })

    return () => {
      active = false
    }
  }, [client, result.mimeType, result.path, workspaceId])

  React.useEffect(() => {
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [objectUrl])

  const download = React.useCallback(() => {
    if (objectUrl) downloadObjectUrl(objectUrl, result.name)
  }, [objectUrl, result.name])

  const saveAs = React.useCallback(async () => {
    if (!data || !objectUrl) return
    if (!isElectronRuntime()) {
      downloadObjectUrl(objectUrl, result.name)
      return
    }

    setSaving(true)
    try {
      const destination = await saveFileContent({
        title: t("session.generated_image_save_as"),
        defaultPath: result.name,
        filters: [{ name: t("session.generated_image_file"), extensions: [extensionOf(result.name)] }],
        dataBase64: arrayBufferToBase64(data),
      })
      if (destination) toast.success(t("session.generated_image_saved"))
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : t("session.generated_image_save_failed"))
    } finally {
      setSaving(false)
    }
  }, [data, objectUrl, result.name])

  const modelLabel = [result.model?.providerID, result.model?.modelID].filter(Boolean).join("/")

  return (
    <div
      className="overflow-hidden rounded-2xl border border-border/80 bg-muted/15"
      data-testid="generated-image-result"
      data-generated-image-path={result.path}
    >
      <div className="flex items-center justify-between gap-3 border-b border-border/70 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <ImageIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{result.name}</div>
            <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              {modelLabel ? <span className="truncate">{modelLabel}</span> : null}
              {modelLabel && result.bytes ? <span aria-hidden="true">·</span> : null}
              {result.bytes ? <span className="shrink-0">{formatFileSize(result.bytes)}</span> : null}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!objectUrl}
            onClick={download}
          >
            <Download className="size-4" />
            {t("session.generated_image_download")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!data || saving}
            onClick={() => void saveAs()}
          >
            {saving ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
            {t("session.generated_image_save_as")}
          </Button>
        </div>
      </div>

      {objectUrl ? (
        <button
          type="button"
          className="flex max-h-[28rem] w-full cursor-zoom-in items-center justify-center overflow-hidden bg-muted/30 p-2 text-left"
          onClick={() => setOpen(true)}
          aria-label={t("session.generated_image_preview")}
        >
          <img
            src={objectUrl}
            alt={result.name}
            className="max-h-[27rem] max-w-full rounded-xl object-contain"
          />
        </button>
      ) : error ? (
        <div className="px-4 py-6 text-sm text-destructive" role="alert">{error}</div>
      ) : (
        <div className="flex h-44 items-center justify-center text-muted-foreground" role="status">
          <LoaderCircle className="size-5 animate-spin" />
          <span className="sr-only">{t("session.generated_image_loading")}</span>
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[94vh] w-[min(94vw,80rem)] max-w-[min(94vw,80rem)] gap-0 overflow-hidden rounded-2xl bg-background p-0 sm:max-w-[min(94vw,80rem)]">
          <DialogTitle className="sr-only">{result.name}</DialogTitle>
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-muted/30 p-4">
            {objectUrl ? (
              <img
                src={objectUrl}
                alt={result.name}
                className="max-h-[calc(94vh-5rem)] max-w-full rounded-xl object-contain"
              />
            ) : null}
          </div>
          <div className="flex items-center justify-between gap-3 border-t bg-background px-4 py-3">
            <span className="min-w-0 truncate text-sm text-muted-foreground">{result.path}</span>
            <div className="flex shrink-0 items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={download} disabled={!objectUrl}>
                <Download className="size-4" />
                {t("session.generated_image_download")}
              </Button>
              <Button type="button" size="sm" onClick={() => void saveAs()} disabled={!data || saving}>
                {saving ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
                {t("session.generated_image_save_as")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
