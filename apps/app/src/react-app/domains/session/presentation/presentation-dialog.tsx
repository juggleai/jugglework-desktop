import * as React from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  PRESENTATION_MAX_SLIDES,
  PRESENTATION_MIN_SLIDES,
  PRESENTATION_REQUEST_VERSION,
  PRESENTATION_TEMPLATES,
  type PresentationRequest,
  type PresentationTemplateId,
  validatePresentationRequest,
} from "./presentation-request";

type PresentationDialogProps = {
  open: boolean;
  currentFile: string | null;
  busy?: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (request: PresentationRequest) => void | Promise<void>;
};

const fieldClass = "grid gap-1.5";
const labelClass = "text-xs font-medium text-foreground";

export function PresentationDialog({ open, currentFile, busy = false, onOpenChange, onSubmit }: PresentationDialogProps) {
  const [purpose, setPurpose] = React.useState("");
  const [audience, setAudience] = React.useState("");
  const [outline, setOutline] = React.useState("");
  const [slideCount, setSlideCount] = React.useState(8);
  const [template, setTemplate] = React.useState<PresentationTemplateId>("executive");
  const [outputName, setOutputName] = React.useState("presentation.pptx");
  const [includeCurrentFile, setIncludeCurrentFile] = React.useState(Boolean(currentFile));
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) setIncludeCurrentFile(Boolean(currentFile));
  }, [currentFile, open]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const request = validatePresentationRequest({
        version: PRESENTATION_REQUEST_VERSION,
        purpose,
        audience,
        outline,
        slideCount,
        template,
        outputName,
        ...(includeCurrentFile && currentFile ? { currentFile: { path: currentFile } } : {}),
      });
      setError(null);
      await onSubmit(request);
      onOpenChange(false);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not create the presentation request.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-2xl" data-testid="presentation-dialog">
        <DialogHeader>
          <DialogTitle>Create presentation</DialogTitle>
          <DialogDescription>Turn this conversation and an optional open file into one editable PowerPoint.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit}>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className={fieldClass}>
              <span className={labelClass}>Purpose</span>
              <Input aria-label="Presentation purpose" value={purpose} onChange={(event) => setPurpose(event.target.value)} placeholder="Quarterly strategy update" />
            </label>
            <label className={fieldClass}>
              <span className={labelClass}>Audience</span>
              <Input aria-label="Presentation audience" value={audience} onChange={(event) => setAudience(event.target.value)} placeholder="Leadership team" />
            </label>
          </div>
          <label className={fieldClass}>
            <span className={labelClass}>Outline and key points</span>
            <Textarea aria-label="Presentation outline" className="min-h-28" value={outline} onChange={(event) => setOutline(event.target.value)} placeholder="Context, findings, recommendation, next steps" />
          </label>
          <div className="grid gap-4 sm:grid-cols-3">
            <label className={fieldClass}>
              <span className={labelClass}>Slides</span>
              <Input aria-label="Slide count" type="number" min={PRESENTATION_MIN_SLIDES} max={PRESENTATION_MAX_SLIDES} value={slideCount} onChange={(event) => setSlideCount(Number(event.target.value))} />
            </label>
            <label className={fieldClass}>
              <span className={labelClass}>Visual template</span>
              <select aria-label="Presentation template" className="h-9 rounded-lg border border-border bg-background px-3 text-sm" value={template} onChange={(event) => setTemplate(event.target.value as PresentationTemplateId)}>
                {PRESENTATION_TEMPLATES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </label>
            <label className={fieldClass}>
              <span className={labelClass}>Output filename</span>
              <Input aria-label="Presentation output filename" value={outputName} onChange={(event) => setOutputName(event.target.value)} />
            </label>
          </div>
          {currentFile ? (
            <label className="flex items-start gap-2 rounded-xl border border-border bg-muted/30 p-3 text-sm">
              <input aria-label="Include current file" className="mt-0.5" type="checkbox" checked={includeCurrentFile} onChange={(event) => setIncludeCurrentFile(event.target.checked)} />
              <span className="min-w-0"><span className="font-medium">Use current file</span><span className="block truncate text-xs text-muted-foreground">{currentFile}</span></span>
            </label>
          ) : null}
          {error ? <div role="alert" className="text-sm text-destructive">{error}</div> : null}
          <DialogFooter className="mt-2">
            <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? "Starting..." : "Create presentation"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
