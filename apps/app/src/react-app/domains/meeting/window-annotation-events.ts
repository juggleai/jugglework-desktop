import type { AnnotationElement, AnnotationStroke, ScreenSize } from "../annotation/annotation-model";
import type { WindowShareCompositor } from "./window-share-compositor";

export type WindowAnnotationScene = { size: ScreenSize; elements: AnnotationElement[]; lasers: { stroke: AnnotationStroke; opacity: number }[] };
type CloseReason = "manual" | "resized" | "target-closed" | "tracking-lost";
type Event = { captureId: string; annotationId: string; seq: number } & (
  { kind: "opened" | "paused" | "resumed" | "geometry-pending" } | { kind: "geometry"; width: number; height: number } |
  { kind: "scene"; scene: WindowAnnotationScene } | { kind: "closed"; reason: CloseReason });

// Shared presentation values for the local Konva overlay and the capture renderer.
export function annotationStrokePoints(stroke: AnnotationStroke, size: ScreenSize) {
  return stroke.points.map((value, i) => value * (i % 2 ? size.height : size.width));
}

export function annotationInkStyle(stroke: AnnotationStroke) {
  return {
    stroke: stroke.color, strokeWidth: stroke.size * (stroke.highlight ? 4 : 1), tension: 0.35,
    opacity: stroke.highlight ? 0.35 : 1,
    globalCompositeOperation: stroke.highlight ? "multiply" as const : "source-over" as const,
  };
}

const LASER_RGB = "255, 59, 48";
const LASER_COLOR = `rgb(${LASER_RGB})`;
const LASER_SHADOW = `rgba(${LASER_RGB}, 0.9)`;

export function annotationLaserStyle(stroke: AnnotationStroke, opacity: number) {
  return { stroke: LASER_COLOR, strokeWidth: Math.max(3, stroke.size), tension: 0.4, opacity,
    shadowColor: LASER_SHADOW, shadowBlur: 14 };
}

export function annotationArrowHeadSize(strokeWidth: number) {
  return Math.max(12, strokeWidth * 3.5);
}

export function createWindowAnnotationReceiver(captureId: string, output: Pick<WindowShareCompositor, "setOverlay" | "confirmSize" | "setGeometryPending" | "setPaused">, onClose: (reason: CloseReason) => void) {
  let current: string | undefined;
  let seq = 0;
  const retired = new Set<string>();
  const reset = () => {
    output.setOverlay(null);
    output.confirmSize(0, 0);
    output.setGeometryPending(false);
    output.setPaused(false);
  };
  // undefined = not yet needed; null = unavailable (do not retry each frame).
  let scratch: CanvasRenderingContext2D | null | undefined;
  const receive = (event: Event) => {
    if (event.captureId !== captureId || !Number.isSafeInteger(event.seq) || event.seq <= 0 ||
        !event.annotationId || retired.has(event.annotationId)) return;
    if (event.kind === "opened") {
      // Opened is a session boundary, never a way to rewind an existing session.
      if (event.annotationId === current) return;
      if (current) retired.add(current);
      current = event.annotationId;
      seq = event.seq;
      reset();
      return;
    }
    if (event.annotationId !== current || event.seq <= seq) {
      if (!current && event.kind === "closed" && event.reason === "target-closed") {
        retired.add(event.annotationId);
        onClose(event.reason);
      }
      return;
    }
    seq = event.seq;
    switch (event.kind) {
      case "geometry-pending": output.setGeometryPending(true); break;
      case "geometry":
        if (Number.isFinite(event.width) && Number.isFinite(event.height) && event.width > 0 && event.height > 0) {
          output.confirmSize(event.width, event.height);
          output.setGeometryPending(false);
        }
        break;
      case "scene": output.setOverlay((ctx, w, h) => {
        if (!event.scene.elements.length && !event.scene.lasers.length) return;
        if (scratch === undefined) scratch = ctx.canvas.ownerDocument.createElement("canvas").getContext("2d");
        if (scratch) drawScene(ctx, scratch, event.scene, w, h);
      }); break;
      case "paused": output.setPaused(true); break;
      case "resumed": output.setPaused(false); break;
      case "closed":
        retired.add(event.annotationId);
        current = undefined;
        reset();
        onClose(event.reason);
    }
  };
  return receive;
}

function drawScene(video: CanvasRenderingContext2D, ink: CanvasRenderingContext2D, scene: WindowAnnotationScene, width: number, height: number) {
  const { canvas } = ink;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const scaleX = width / scene.size.width, scaleY = height / scene.size.height;
  const resetLayer = () => {
    ink.setTransform(1, 0, 0, 1, 0, 0);
    ink.clearRect(0, 0, width, height);
    ink.scale(scaleX, scaleY);
  };

  video.save();
  try {
    video.globalAlpha = 1;
    video.globalCompositeOperation = "source-over";
    // Multiply can see earlier ink but never the opaque video. Lasers are a
    // separate transparent layer locally; reuse the same bitmap for that pass.
    if (scene.elements.length) {
      resetLayer();
      for (const element of scene.elements) drawElement(ink, element, scene.size);
      video.drawImage(canvas, 0, 0);
    }
    if (scene.lasers.length) {
      resetLayer();
      for (const { stroke, opacity } of scene.lasers) {
        if (opacity <= 0) continue;
        const style = annotationLaserStyle(stroke, opacity);
        ink.save();
        ink.strokeStyle = style.stroke;
        ink.lineWidth = style.strokeWidth;
        ink.lineCap = ink.lineJoin = "round";
        ink.globalAlpha = style.opacity;
        // Canvas shadow blur does not follow the transform; Konva scales it by
        // the smaller backing-pixel ratio and applies both alpha factors.
        ink.shadowBlur = style.shadowBlur * Math.min(scaleX, scaleY);
        ink.shadowColor = style.shadowColor;
        strokePath(ink, annotationStrokePoints(stroke, scene.size), style.tension);
        ink.restore();
      }
      video.drawImage(canvas, 0, 0);
    }
  } finally { video.restore(); }
}

function drawElement(ctx: CanvasRenderingContext2D, element: AnnotationElement, size: ScreenSize) {
  ctx.save();
  ctx.lineCap = ctx.lineJoin = "round";
  if (element.type === "stroke") {
    const style = annotationInkStyle(element);
    ctx.strokeStyle = style.stroke;
    ctx.lineWidth = style.strokeWidth;
    ctx.globalAlpha = style.opacity;
    ctx.globalCompositeOperation = style.globalCompositeOperation;
    strokePath(ctx, annotationStrokePoints(element, size), style.tension);
  } else {
    const { width, height } = size;
    ctx.strokeStyle = element.color;
    ctx.lineWidth = element.size;
    const x1 = element.x1 * width, y1 = element.y1 * height, x2 = element.x2 * width, y2 = element.y2 * height;
    ctx.beginPath();
    if (element.kind === "rectangle") {
      ctx.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    } else if (element.kind === "ellipse") {
      ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
    } else {
      ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      const head = annotationArrowHeadSize(element.size);
      ctx.save();
      ctx.beginPath();
      ctx.translate(x2, y2);
      ctx.rotate((Math.atan2(y2 - y1, x2 - x1) + Math.PI * 2) % (Math.PI * 2));
      ctx.moveTo(0, 0); ctx.lineTo(-head, head / 2); ctx.lineTo(-head, -head / 2);
      ctx.restore();
      ctx.fillStyle = element.color;
    }
    ctx.closePath();
    if (element.kind === "arrow") ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

// Konva's open Line path: straight with up to two samples, then quadratic
// ends and cubic interiors. Compute controls in viewport CSS pixels, before
// applying the capture transform (the two axes may scale differently).
function strokePath(ctx: CanvasRenderingContext2D, points: number[], tension: number) {
  if (!points.length) return;
  ctx.beginPath();
  ctx.moveTo(points[0], points[1]);
  if (points.length === 4) ctx.lineTo(points[2], points[3]);
  else if (points.length > 4) {
    let outX = points[0], outY = points[1];
    for (let i = 2; i < points.length - 2; i += 2) {
      const x = points[i], y = points[i + 1];
      const prevX = points[i - 2], prevY = points[i - 1], nextX = points[i + 2], nextY = points[i + 3];
      const before = Math.sqrt((x - prevX) ** 2 + (y - prevY) ** 2);
      const after = Math.sqrt((nextX - x) ** 2 + (nextY - y) ** 2);
      const length = before + after;
      const incoming = length ? tension * before / length : 0;
      const outgoing = length ? tension * after / length : 0;
      const dx = nextX - prevX, dy = nextY - prevY;
      const inX = x - incoming * dx, inY = y - incoming * dy;
      if (i === 2) ctx.quadraticCurveTo(inX, inY, x, y);
      else ctx.bezierCurveTo(outX, outY, inX, inY, x, y);
      outX = x + outgoing * dx;
      outY = y + outgoing * dy;
    }
    ctx.quadraticCurveTo(outX, outY, points[points.length - 2], points[points.length - 1]);
  }
  ctx.stroke();
}
