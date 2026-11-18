/** @jsxImportSource react */
// The ONLY module allowed to import @excalidraw/excalidraw (enforced by
// tests/meeting-whiteboard-boundary.test.ts). Phase two adds collaboration here.
import "@excalidraw/excalidraw/index.css";
import { CaptureUpdateAction, Excalidraw, exportToBlob, MIME_TYPES, serializeAsJSON } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI, ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from "react";
import { parseWhiteboardScene } from "./scene";

export type MeetingWhiteboardHandle = {
  /** Current scene as Excalidraw's native JSON. */
  exportSource(): string | null;
  exportPng(): Promise<Blob | null>;
  /** Phase two: merge remote elements without touching local undo history. */
  applyRemoteScene(elements: readonly unknown[]): void;
  /** Phase two: render collaborator cursors. */
  setCollaborators(collaborators: Map<string, unknown>): void;
};

export type MeetingWhiteboardProps = {
  initialScene: string | null;
  onSceneChange(json: string): void;
  readonly?: boolean;
  theme: "light" | "dark";
  langCode?: string;
};

// Phase one disables every surface that would reach the network.
const UI_OPTIONS = {
  canvasActions: { loadScene: false, saveToActiveFile: false, export: false as const, saveAsImage: false, toggleTheme: null },
  tools: { image: true },
};

export const MeetingWhiteboard = forwardRef<MeetingWhiteboardHandle, MeetingWhiteboardProps>(function MeetingWhiteboard(
  { initialScene, onSceneChange, readonly = false, theme, langCode = "zh-CN" },
  ref,
) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const lastSerialized = useRef<string | null>(initialScene);
  // parseWhiteboardScene validated the shape; Excalidraw restores element details.
  const initialData = useMemo(() => parseWhiteboardScene(initialScene) as ExcalidrawInitialDataState | null, [initialScene]);

  const serialize = useCallback((target: ExcalidrawImperativeAPI) =>
    serializeAsJSON(target.getSceneElementsIncludingDeleted(), target.getAppState(), target.getFiles(), "local"), []);

  useImperativeHandle(ref, () => ({
    exportSource: () => (apiRef.current ? serialize(apiRef.current) : null),
    async exportPng() {
      const target = apiRef.current;
      if (!target) return null;
      return exportToBlob({
        elements: target.getSceneElements(),
        appState: { ...target.getAppState(), exportBackground: true },
        files: target.getFiles(),
        mimeType: MIME_TYPES.png,
      });
    },
    applyRemoteScene(elements) {
      apiRef.current?.updateScene({ elements: elements as never, captureUpdate: CaptureUpdateAction.NEVER });
    },
    setCollaborators() { /* Phase two. */ },
  }), [serialize]);

  const handleChange = useCallback(() => {
    const target = apiRef.current;
    if (!target) return;
    // onChange also fires for pointer moves and selection; only report real edits.
    const json = serialize(target);
    if (json === lastSerialized.current) return;
    lastSerialized.current = json;
    onSceneChange(json);
  }, [onSceneChange, serialize]);

  return (
    <Excalidraw
      excalidrawAPI={(next) => { apiRef.current = next; if (next !== api) setApi(next); }}
      initialData={initialData}
      onChange={handleChange}
      langCode={langCode}
      theme={theme}
      viewModeEnabled={readonly}
      UIOptions={UI_OPTIONS}
      validateEmbeddable={false}
      aiEnabled={false}
      handleKeyboardGlobally
      onLinkOpen={(_element, event) => event.preventDefault()}
    />
  );
});
