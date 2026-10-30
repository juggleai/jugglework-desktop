/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { X } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import { Button } from "@/components/ui/button";
import { captureTerminalTarget, consumeTerminalOutput } from "./terminal-state";
import { readTerminalTheme, observeTerminalTheme } from "./terminal-theme";

type Props = { workspaceId: string; sessionId: string; isRemoteWorkspace: boolean; onClose: () => void };

export function TerminalDock(props: Props) {
  // Capture the action pane at open time; subsequent focus/tab changes do not
  // silently spawn another shell or relabel this one.
  const [{ workspaceId, sessionId, isRemoteWorkspace }] = useState(() => captureTerminalTarget(props));
  const { onClose } = props;
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const bridge = window.__JUGGLEWORK_ELECTRON__?.terminal;
    setError("");
    if (!bridge || !container.current || !workspaceId || !sessionId || isRemoteWorkspace) {
      setError(isRemoteWorkspace ? "Remote terminals are unsupported." : "Select a local desktop session.");
      return;
    }
    const terminal = new Terminal({ cursorBlink: true, fontSize: 12, scrollback: 3000, theme: readTerminalTheme(container.current) });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container.current);
    const stopThemeSync = observeTerminalTheme(container.current, (theme) => { terminal.options.theme = theme; });
    let disposed = false;
    let id: string | null = null;
    let cursor = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fail = (e: unknown) => { if (!disposed) setError(e instanceof Error ? e.message : String(e)); };
    const resize = () => {
      fit.fit();
      if (id) void bridge.resize?.(id, terminal.cols, terminal.rows).catch(fail);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container.current);
    const input = terminal.onData((data) => { if (id) void bridge.write?.(id, data).catch(fail); });
    // Confirm multiline paste before xterm receives the clipboard event.
    const element = container.current;
    const paste = (event: ClipboardEvent) => {
      if (/[\r\n]/.test(event.clipboardData?.getData("text/plain") ?? "") && !window.confirm("Paste multiple lines into the shell? This may execute commands.")) {
        event.preventDefault(); event.stopImmediatePropagation();
      }
    };
    element.addEventListener("paste", paste, true);
    const poll = async () => {
      if (disposed || !id) return;
      try {
        const result = await bridge.read(id, cursor);
        if (disposed) return;
        cursor = await consumeTerminalOutput(cursor, result, (text) => new Promise<void>((resolve) => terminal.write(text, resolve)));
        if (disposed) return;
        timer = setTimeout(() => void poll(), 60);
      } catch (e) { fail(e); }
    };
    void bridge.open({ workspaceId, sessionId }).then((result) => {
      if (disposed) return; // Hide detaches only; host retains the fixed binding.
      id = result.terminalId;
      if (result.stale) setError("This terminal is still associated with its original execution directory.");
      resize(); terminal.focus(); void poll();
    }).catch(fail);
    return () => {
      disposed = true;
      clearTimeout(timer);
      observer.disconnect(); input.dispose();
      stopThemeSync();
      element.removeEventListener("paste", paste, true);
      terminal.dispose();
    };
  }, [workspaceId, sessionId, isRemoteWorkspace]);
  return <section className="flex h-full min-h-0 flex-col border-t border-border bg-background text-foreground" aria-label="Terminal">
    <header className="flex h-7 shrink-0 items-center justify-between border-b border-border bg-muted pl-3 pr-1 text-muted-foreground">
      <span className="text-xs font-medium">Terminal</span>
      <Button variant="ghost" size="icon-sm" className="size-6" aria-label="Hide terminal" title="Hide terminal" onClick={onClose}>
        <X size={14} aria-hidden="true" />
      </Button>
    </header>
    {error ? <div role="status" className="px-3 text-xs text-warning">{error}</div> : null}
    <div ref={container} className="min-h-0 flex-1 px-2 py-1 [&_.xterm]:h-full" />
  </section>;
}
