import type { MeetingSemanticKey, MeetingSemanticNativeEvent, MeetingSemanticScene } from "@jugglework/types/desktop-ipc";
import { writeMeetingSemanticAnnotation } from "@/app/lib/desktop";
import { createMeetingSemanticAnnotationSession, type SemanticPointerBatch } from "./meeting-semantic-annotation-session";
import type { WindowAnnotationScene } from "./window-annotation-events";

export function createMeetingSemanticAnnotationController(captureId: string) {
  let key: MeetingSemanticKey | null = null;
  let session: ReturnType<typeof createMeetingSemanticAnnotationSession> | null = null;
  let input: ((batch: SemanticPointerBatch) => void) | null = null;
  let eventSeq = 0, sceneRevision = 0, previewRevision = 0, laserRevision = 0, sceneInFlight = false, previewInFlight = false, laserInFlight = false;
  let pendingScene: { revision: number; scene: WindowAnnotationScene; history: { canUndo: boolean; canClear: boolean } } | null = null;
  let pendingPreview: { revision: number; epoch: number; hiddenElementIds: string[]; scene: WindowAnnotationScene } | null = null;
  let pendingLasers: { revision: number; epoch: number; scene: WindowAnnotationScene } | null = null;
  let protocolWrites = Promise.resolve<{ ok: boolean; reason?: string }>({ ok: true });
  const write = (input: Parameters<typeof writeMeetingSemanticAnnotation>[0]) => {
    const next = protocolWrites.then(() => writeMeetingSemanticAnnotation(input));
    protocolWrites = next.catch(() => ({ ok: false, reason: "native-write-failed" }));
    return next;
  };
  const toScene = (value: WindowAnnotationScene): MeetingSemanticScene => ({ size: value.size, lasers: [], elements: value.elements.map(element => {
    if (element.type === "stroke") return { type: "stroke", id: element.id, color: element.color, size: element.size, highlight: element.highlight, points: element.points };
    return { type: "shape", id: element.id, kind: element.kind, color: element.color, size: element.size, x1: element.x1, y1: element.y1, x2: element.x2, y2: element.y2 };
  }) });
  const close = () => { session?.dispose(); session = null; key = null; input = null; pendingScene = null; pendingPreview = null; pendingLasers = null; sceneInFlight = false; previewInFlight = false; laserInFlight = false;
    protocolWrites = Promise.resolve({ ok: true }); eventSeq = 0; sceneRevision = 0; previewRevision = 0; laserRevision = 0; };
  const pumpScene = async (bound: MeetingSemanticKey) => {
    if (sceneInFlight) return;
    sceneInFlight = true;
    while (key === bound && pendingScene) {
      const next = pendingScene; pendingScene = null;
      const scene = toScene(next.scene);
      const result = await write({ ...bound, command: "apply-scene", sceneRevision: next.revision, scene, history: next.history });
      if (!result.ok) { close(); break; }
    }
    sceneInFlight = false;
  };
  const pumpPreview = async (bound: MeetingSemanticKey) => {
    if (previewInFlight) return;
    previewInFlight = true;
    while (key === bound && pendingPreview) {
      const next = pendingPreview; pendingPreview = null;
      const result = await write({ ...bound, command: "apply-preview", previewRevision: next.revision,
        epoch: next.epoch, hiddenElementIds: next.hiddenElementIds, scene: toScene(next.scene) });
      if (!result.ok && result.reason !== "stale-preview") { close(); break; }
    }
    previewInFlight = false;
  };
  const pumpLasers = async (bound: MeetingSemanticKey) => {
    if (laserInFlight) return;
    laserInFlight = true;
    while (key === bound && pendingLasers) {
      const next = pendingLasers; pendingLasers = null;
      const result = await write({ ...bound, command: "apply-lasers", laserRevision: next.revision, epoch: next.epoch,
        lasers: next.scene.lasers.map(({ stroke, opacity }) => ({ stroke, opacity })) });
      if (!result.ok && result.reason !== "stale-laser") { close(); break; }
    }
    laserInFlight = false;
  };
  const receive = (event: MeetingSemanticNativeEvent) => {
    if (event.captureId !== captureId || !Number.isSafeInteger(event.seq) || event.seq <= 0) return;
    if (event.kind === "opened") {
      close();
      key = { captureId: event.captureId, annotationId: event.annotationId, nativeSessionId: event.nativeSessionId, generation: event.generation };
      eventSeq = event.seq;
      const bound = key;
      session = createMeetingSemanticAnnotationSession({
        size: event.size,
        overlay: {
          sessionId: bound.nativeSessionId,
          onInput(callback) { input = callback; return () => { input = null; }; },
          setMode: (mode, style) => write(mode === "pointer" ? { ...bound, command: "mode", mode } : { ...bound, command: "mode", mode, style: style! }),
          abort: () => write({ ...bound, command: "abort" }),
        },
        onScene(scene, committed, preview, laserEpoch) {
          if (key !== bound || !session) return;
          if (laserEpoch !== undefined) { pendingLasers = { revision: ++laserRevision, epoch: laserEpoch, scene }; void pumpLasers(bound); }
          if (committed) { pendingPreview = null; pendingScene = { revision: ++sceneRevision, scene, history: session.getHistory() }; void pumpScene(bound); return; }
          if (!preview) return;
          pendingPreview = { revision: ++previewRevision, epoch: preview?.epoch ?? -1, hiddenElementIds: preview?.hiddenElementIds ?? [], scene };
          void pumpPreview(bound);
        },
        onFailure() { close(); },
      });
      return;
    }
    if (!key || event.annotationId !== key.annotationId || event.nativeSessionId !== key.nativeSessionId || event.generation !== key.generation || event.seq <= eventSeq) return;
    eventSeq = event.seq;
    if (event.kind === "pointer") input?.(event.batch);
    else if (event.kind === "toolbar") {
      const command = event.command as { type?: string; tool?: { tool?: string; color?: string; size?: number } };
      if (command.type === "tool" && command.tool?.tool === "pointer") void session?.setPointer();
       else if (command.type === "tool" && ["laser", "pen", "highlighter", "rectangle", "ellipse", "arrow", "eraser"].includes(command.tool?.tool ?? ""))
         void session?.setTool(command.tool as Parameters<NonNullable<typeof session>["setTool"]>[0]);
      else if (command.type === "undo") session?.undo();
      else if (command.type === "clear") session?.clear();
    } else if (event.kind === "state") session?.clearTransient(event.epoch);
    else if (event.kind === "closed") close();
  };
  return { receive, close };
}
