/** @jsxImportSource react */
import type { AgentRuntimeCatalog } from "@jugglework/types/agent-runtime";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";

import { describeAgentRuntimeUnavailable, isAgentRuntimeSelectable } from "../agent-runtime-experience";

export function AgentRuntimePickerDialog(props: {
  open: boolean;
  catalog: AgentRuntimeCatalog | null;
  selectedRuntimeId: string;
  loading: boolean;
  error: string | null;
  onSelect: (runtimeId: string) => void;
  onClose: () => void;
  onCreate: () => void;
}) {
  const selected = props.catalog?.runtimes.find((runtime) => runtime.id === props.selectedRuntimeId) ?? null;
  return (
    <Dialog open={props.open} onOpenChange={(open) => { if (!open && !props.loading) props.onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Choose Agent Runtime</DialogTitle>
          <DialogDescription>
            The runtime is permanently bound to this session. Agent profile and model remain separate settings.
          </DialogDescription>
        </DialogHeader>
        {props.catalog ? (
          <RadioGroup value={props.selectedRuntimeId} onValueChange={(value) => props.onSelect(String(value))}>
            {props.catalog.runtimes.map((runtime) => {
              const reason = describeAgentRuntimeUnavailable(runtime);
              const selectable = isAgentRuntimeSelectable(runtime);
              return (
                <label key={runtime.id} className={cn(
                  "flex items-start gap-3 rounded-2xl border border-border px-4 py-3",
                  selectable ? "cursor-pointer hover:bg-muted/40" : "cursor-not-allowed opacity-70",
                  props.selectedRuntimeId === runtime.id && selectable && "border-primary/50 bg-primary/5",
                )}>
                  <RadioGroupItem value={runtime.id} disabled={!selectable || props.loading} className="mt-0.5" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 font-medium">
                      {runtime.label}
                      {runtime.isDefault ? <span className="text-xs font-normal text-muted-foreground">Default</span> : null}
                    </span>
                    {runtime.description ? <span className="mt-1 block text-xs text-muted-foreground">{runtime.description}</span> : null}
                    {reason ? <span className="mt-2 block text-xs leading-5 text-destructive">{reason}</span> : null}
                  </span>
                </label>
              );
            })}
          </RadioGroup>
        ) : <div className="rounded-2xl border border-border px-4 py-6 text-sm text-muted-foreground">Loading Agent Runtimes...</div>}
        {props.error ? <p role="alert" className="text-sm text-destructive">{props.error}</p> : null}
        <DialogFooter>
          <Button variant="outline" disabled={props.loading} onClick={props.onClose}>Cancel</Button>
          <Button disabled={props.loading || !selected || !isAgentRuntimeSelectable(selected)} onClick={props.onCreate}>
            {props.loading ? "Creating..." : "Create session"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
