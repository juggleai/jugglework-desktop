/** @jsxImportSource react */
import type { AgentContinuationContext, AgentContinuationPreview } from "@jugglework/types/agent-runtime";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

export function AgentContinuationDialog(props: {
  open: boolean;
  preview: AgentContinuationPreview | null;
  context: AgentContinuationContext | null;
  loading: boolean;
  error: string | null;
  onContextChange: (context: AgentContinuationContext) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const omissions = props.preview?.omissions;
  const omitted = omissions ? Object.values(omissions).reduce((total, value) => total + value, 0) : 0;
  return (
    <Dialog open={props.open} onOpenChange={(open) => { if (!open && !props.loading) props.onCancel(); }}>
      <DialogContent className="max-h-[min(820px,calc(100vh-2rem))] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Continue with Claude Agent</DialogTitle>
          <DialogDescription>
            Review the bounded context used to create a linked Claude session. The source session stays unchanged. Tools, pending requests, hidden content, secrets, and attachment contents are not transferred.
          </DialogDescription>
        </DialogHeader>
        {props.preview && props.context ? (
          <div className="space-y-5">
            <div className="flex flex-wrap gap-x-5 gap-y-1 rounded-xl border border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
              <span>Source: {props.preview.sourceTitle}</span>
              <span>{props.preview.selectedCharacters.toLocaleString()} / {props.preview.maxCharacters.toLocaleString()} characters</span>
              <span>{props.context.transcript.length} attributed messages</span>
              {omitted > 0 ? <span>{omitted} unsafe or unsupported items omitted</span> : null}
            </div>
            <label className="block space-y-2">
              <span className="text-sm font-medium">Summary</span>
              <Textarea
                aria-label="Migration summary"
                className="min-h-36 resize-y"
                maxLength={8_000}
                value={props.context.summary}
                onChange={(event) => props.onContextChange({ ...props.context!, summary: event.currentTarget.value })}
              />
            </label>
            <div className="space-y-3">
              <div>
                <div className="text-sm font-medium">Attributed transcript</div>
                <div className="text-xs text-muted-foreground">Edit or remove text before creating the linked session.</div>
              </div>
              {props.context.transcript.map((entry, index) => (
                <div key={`${entry.sourceMessageId ?? index}:${index}`} className="rounded-xl border border-border p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{entry.role}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => props.onContextChange({
                        ...props.context!,
                        transcript: props.context!.transcript.filter((_, itemIndex) => itemIndex !== index),
                      })}
                    >Remove</Button>
                  </div>
                  <Textarea
                    aria-label={`${entry.role} migration text ${index + 1}`}
                    className="min-h-24 resize-y"
                    maxLength={40_000}
                    value={entry.text}
                    onChange={(event) => props.onContextChange({
                      ...props.context!,
                      transcript: props.context!.transcript.map((item, itemIndex) => itemIndex === index
                        ? { ...item, text: event.currentTarget.value }
                        : item),
                    })}
                  />
                </div>
              ))}
            </div>
          </div>
        ) : <div className="rounded-xl border border-border px-4 py-8 text-center text-sm text-muted-foreground">Preparing a safe migration preview...</div>}
        {props.error ? <p role="alert" className="text-sm text-destructive">{props.error}</p> : null}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={props.loading} onClick={props.onCancel}>Cancel</Button>
          <Button
            type="button"
            disabled={props.loading || !props.context?.summary.trim()}
            onClick={props.onConfirm}
          >{props.loading ? "Creating linked session..." : "Continue with Claude"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
