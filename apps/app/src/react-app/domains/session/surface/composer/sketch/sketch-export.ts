import {
  SKETCH_LOGICAL_HEIGHT,
  SKETCH_LOGICAL_WIDTH,
  sketchExportDimensions,
  sketchFilename,
  type SketchElement,
} from "./sketch-model";

function drawArrowHead(
  context: CanvasRenderingContext2D,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  width: number,
) {
  const angle = Math.atan2(endY - startY, endX - startX);
  const length = Math.max(12, width * 4);
  context.beginPath();
  context.moveTo(endX, endY);
  context.lineTo(endX - length * Math.cos(angle - Math.PI / 6), endY - length * Math.sin(angle - Math.PI / 6));
  context.moveTo(endX, endY);
  context.lineTo(endX - length * Math.cos(angle + Math.PI / 6), endY - length * Math.sin(angle + Math.PI / 6));
  context.stroke();
}

export function renderSketchToContext(
  context: CanvasRenderingContext2D,
  elements: SketchElement[],
  scale = 1,
) {
  context.save();
  context.scale(scale, scale);
  context.lineCap = "round";
  context.lineJoin = "round";

  for (const element of elements) {
    context.strokeStyle = element.color;
    context.fillStyle = element.color;
    context.lineWidth = element.strokeWidth;

    if (element.type === "stroke") {
      if (element.points.length < 2) continue;
      context.beginPath();
      context.moveTo(element.x + element.points[0]!, element.y + element.points[1]!);
      for (let index = 2; index < element.points.length; index += 2) {
        context.lineTo(element.x + element.points[index]!, element.y + element.points[index + 1]!);
      }
      context.stroke();
      continue;
    }

    if (element.type === "line" || element.type === "arrow") {
      const [x1, y1, x2, y2] = element.points;
      context.beginPath();
      context.moveTo(element.x + x1, element.y + y1);
      context.lineTo(element.x + x2, element.y + y2);
      context.stroke();
      if (element.type === "arrow") {
        drawArrowHead(context, element.x + x1, element.y + y1, element.x + x2, element.y + y2, element.strokeWidth);
      }
      continue;
    }

    if (element.type === "rectangle") {
      context.strokeRect(element.x, element.y, element.width, element.height);
      continue;
    }

    if (element.type === "ellipse") {
      context.beginPath();
      context.ellipse(
        element.x + element.width / 2,
        element.y + element.height / 2,
        Math.abs(element.width / 2),
        Math.abs(element.height / 2),
        0,
        0,
        Math.PI * 2,
      );
      context.stroke();
      continue;
    }

    context.font = `${element.fontSize}px "Geist Variable", "IBM Plex Sans", sans-serif`;
    context.textBaseline = "top";
    const lines = element.text.split("\n");
    lines.forEach((line, index) => {
      context.fillText(line, element.x, element.y + index * element.fontSize * 1.25, element.width);
    });
  }

  context.restore();
}

export async function exportSketchFile(
  elements: SketchElement[],
  now = new Date(),
  createCanvas: () => HTMLCanvasElement = () => document.createElement("canvas"),
) {
  const dimensions = sketchExportDimensions(SKETCH_LOGICAL_WIDTH, SKETCH_LOGICAL_HEIGHT);
  const canvas = createCanvas();
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas export is unavailable.");

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  renderSketchToContext(context, elements, dimensions.scale);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("The sketch could not be rendered.");
  return new File([blob], sketchFilename(now), { type: "image/png", lastModified: now.getTime() });
}
