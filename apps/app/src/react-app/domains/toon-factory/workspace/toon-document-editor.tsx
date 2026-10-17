/** @jsxImportSource react */
import { useEffect, useRef } from "react";

export type ToonDocumentEditorView = {
  cursor: number;
  selection: { from: number; to: number };
  scrollTop: number;
};

export default function ToonDocumentEditor(props: { value: string; view: ToonDocumentEditorView; readOnly?: boolean; language: "markdown" | "text"; reveal?: { from: number; to: number } | null; onChange: (value: string, view: ToonDocumentEditorView) => void; onViewChange: (view: ToonDocumentEditorView) => void }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const callbacks = useRef(props);
  callbacks.current = props;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let view: import("@codemirror/view").EditorView | null = null;
    void Promise.all([
      import("@codemirror/state"),
      import("@codemirror/view"),
      import("@codemirror/commands"),
      import("@codemirror/lang-markdown"),
    ]).then(([state, viewModule, commands, markdown]) => {
      if (disposed) return;
      const selection = Math.min(callbacks.current.view.selection.from, callbacks.current.value.length);
      view = new viewModule.EditorView({
        parent: host,
        state: state.EditorState.create({
          doc: callbacks.current.value,
          selection: { anchor: selection, head: Math.min(callbacks.current.view.selection.to, callbacks.current.value.length) },
          extensions: [
            viewModule.lineNumbers(),
            viewModule.drawSelection(),
            viewModule.highlightActiveLine(),
            viewModule.keymap.of([...commands.defaultKeymap, ...commands.historyKeymap]),
            commands.history(),
             ...(callbacks.current.language === "markdown" ? [markdown.markdown()] : []),
            state.EditorState.readOnly.of(Boolean(callbacks.current.readOnly)),
            viewModule.EditorView.lineWrapping,
            viewModule.EditorView.theme({
              "&": { height: "100%", background: "transparent", color: "var(--dls-text)" },
              ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "13px", lineHeight: "1.65" },
              ".cm-gutters": { background: "var(--app-list-bg)", color: "var(--dls-secondary)", border: "none" },
              ".cm-activeLine, .cm-activeLineGutter": { background: "color-mix(in srgb, var(--dls-accent) 8%, transparent)" },
              "&.cm-focused": { outline: "none" },
            }),
            viewModule.EditorView.updateListener.of((update) => {
              const selectionValue = update.state.selection.main;
              const nextView = { cursor: selectionValue.head, selection: { from: selectionValue.from, to: selectionValue.to }, scrollTop: update.view.scrollDOM.scrollTop };
              if (update.docChanged) callbacks.current.onChange(update.state.doc.toString(), nextView);
              else if (update.selectionSet || update.viewportChanged) callbacks.current.onViewChange(nextView);
            }),
          ],
        }),
      });
      view.scrollDOM.scrollTop = callbacks.current.view.scrollTop;
      if (callbacks.current.reveal) {
        const from = Math.min(callbacks.current.reveal.from, view.state.doc.length);
        const to = Math.min(callbacks.current.reveal.to, view.state.doc.length);
        view.dispatch({ selection: { anchor: from, head: to }, effects: viewModule.EditorView.scrollIntoView(from, { y: "center" }) });
      }
      view.focus();
    });
    return () => { disposed = true; view?.destroy(); };
   }, [props.language, props.readOnly, props.reveal]);

  return <div ref={hostRef} className="h-full min-h-0 overflow-hidden" data-testid="toon-document-editor" />;
}
