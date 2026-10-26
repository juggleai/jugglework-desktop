import { AlertTriangle, CircleAlert } from "lucide-react"

import { Message } from "@/components/ui/message"
import { t } from "@/i18n"
import { isPointsExhaustedMessage } from "@/react-app/domains/session/sync/provider-limit-classify"

/** Display-only filtering: keep the original diagnostic and task state intact. */
export function isMissingFileSessionError(error: string | null): boolean {
  if (!error) return false
  const message = error.trim().replace(/^(?:Error|NotFoundError):\s*/i, "")
  return /^File not found(?:\s*:|\s*$)/i.test(message)
    || /^ENOENT:\s*no such file or directory,\s*(?:open|stat|lstat|scandir|access|readfile)\b/i.test(message)
}

export function SessionErrorMessage({ error }: { error: string | null }) {
  if (isMissingFileSessionError(error)) return null
  if (isPointsExhaustedMessage(error)) {
    return (
      <div role="status" data-testid="session-points-exhausted" className="not-prose my-6 flex w-full items-center gap-3 text-sm text-dls-secondary">
        <span aria-hidden className="h-px min-w-4 flex-1 bg-dls-border" />
        <span className="flex min-w-0 items-center justify-center gap-2 text-center">
          <CircleAlert className="size-4 shrink-0" />
          {t("session.usage_limit_recharge")}
        </span>
        <span aria-hidden className="h-px min-w-4 flex-1 bg-dls-border" />
      </div>
    )
  }

  return (
    <Message className="not-prose mx-auto flex w-full max-w-3xl flex-col items-start gap-2 px-0 md:px-10">
      <div className="group flex w-full flex-col items-start gap-0">
        <div className="text-foreground flex min-w-0 flex-1 flex-row items-start gap-2 rounded-lg border-2 border-red-300 bg-red-300/20 px-2 py-1">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-destructive" />
          <p className="whitespace-pre-wrap text-destructive">{error}</p>
        </div>
      </div>
    </Message>
  )
}
