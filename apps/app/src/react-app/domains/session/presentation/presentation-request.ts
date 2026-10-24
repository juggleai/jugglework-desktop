import type { ComposerDraft } from "@/app/types";

export const PRESENTATION_REQUEST_VERSION = 1 as const;
export const PRESENTATION_MIN_SLIDES = 1;
export const PRESENTATION_MAX_SLIDES = 30;

export const PRESENTATION_TEMPLATES = [
  { id: "executive", version: 1, label: "Executive", description: "Dark navy, high-contrast business brief" },
  { id: "editorial", version: 1, label: "Editorial", description: "Warm paper, strong typographic hierarchy" },
  { id: "minimal", version: 1, label: "Minimal", description: "Clean white canvas with a restrained accent" },
] as const;

export type PresentationTemplateId = typeof PRESENTATION_TEMPLATES[number]["id"];

export type PresentationRequest = {
  version: typeof PRESENTATION_REQUEST_VERSION;
  purpose: string;
  audience: string;
  outline: string;
  slideCount: number;
  template: PresentationTemplateId;
  outputName: string;
  currentFile?: { path: string; name: string };
};

const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f]/;
const SAFE_SOURCE_EXTENSIONS = new Set(["docx", "pptx", "xlsx", "csv", "pdf", "md", "markdown", "txt"]);

function boundedText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${field} is required.`);
  const text = value.trim();
  if (!text) throw new Error(`${field} is required.`);
  if (text.length > max || CONTROL_CHARACTER_RE.test(text)) throw new Error(`${field} is invalid.`);
  return text;
}

function normalizeOutputName(value: unknown): string {
  const outputName = boundedText(value, "Output name", 120);
  if (outputName.includes("/") || outputName.includes("\\") || outputName === "." || outputName === "..") {
    throw new Error("Output name must be a filename, not a path.");
  }
  return outputName.toLowerCase().endsWith(".pptx") ? outputName : `${outputName}.pptx`;
}

function validateCurrentFile(value: unknown): PresentationRequest["currentFile"] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") throw new Error("Current file is invalid.");
  const path = boundedText((value as { path?: unknown }).path, "Current file path", 1_024).replace(/\\/g, "/");
  if (path.startsWith("/") || /^[a-zA-Z]:\//.test(path) || path.split("/").includes("..")) {
    throw new Error("Current file must be workspace-relative.");
  }
  const name = path.split("/").filter(Boolean).at(-1) ?? "";
  const extension = name.split(".").at(-1)?.toLowerCase() ?? "";
  if (!name || !SAFE_SOURCE_EXTENSIONS.has(extension)) throw new Error("Current file type is not supported as presentation source.");
  return { path, name };
}

export function presentationSourcePath(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return validateCurrentFile({ path: value })?.path ?? null;
  } catch {
    return null;
  }
}

export function validatePresentationRequest(value: unknown): PresentationRequest {
  if (!value || typeof value !== "object") throw new Error("Presentation request is required.");
  const input = value as Partial<PresentationRequest>;
  if (input.version !== PRESENTATION_REQUEST_VERSION) throw new Error("Unsupported presentation request version.");
  if (!Number.isInteger(input.slideCount) || Number(input.slideCount) < PRESENTATION_MIN_SLIDES || Number(input.slideCount) > PRESENTATION_MAX_SLIDES) {
    throw new Error(`Slide count must be between ${PRESENTATION_MIN_SLIDES} and ${PRESENTATION_MAX_SLIDES}.`);
  }
  if (!PRESENTATION_TEMPLATES.some((template) => template.id === input.template)) throw new Error("Presentation template is invalid.");
  const currentFile = validateCurrentFile(input.currentFile);
  return {
    version: PRESENTATION_REQUEST_VERSION,
    purpose: boundedText(input.purpose, "Purpose", 2_000),
    audience: boundedText(input.audience, "Audience", 1_000),
    outline: boundedText(input.outline, "Outline", 12_000),
    slideCount: Number(input.slideCount),
    template: input.template!,
    outputName: normalizeOutputName(input.outputName),
    ...(currentFile ? { currentFile } : {}),
  };
}

export function buildPresentationPrompt(value: unknown): string {
  const request = validatePresentationRequest(value);
  const source = request.currentFile
    ? `Use the attached structured file part named ${JSON.stringify(request.currentFile.name)} as source material.`
    : "Use this session's conversation as the source material; no current file was selected.";
  return [
    "Create one editable PowerPoint presentation using JuggleWork's bundled presentation generator.",
    source,
    "Do not install packages, call Office lifecycle tools, handcraft an unvalidated artifact, or use artifact.register_outputs.",
    "First turn the request into one compact JSON object with exactly: version=1; template=executive, editorial, or minimal; outputName as a safe .pptx filename; and slides as 1-30 objects containing title, optional subtitle, and optional bullets.",
    "Invoke jugglework_artifact_generate exactly once with program='jugglework:presentation-generator', args=['--spec-json', '<compact-json>', '--output', '<outputName>'], outputs=['<outputName>'], and timeoutMs=60000.",
    "The generator must write the requested PPTX into JUGGLEWORK_ARTIFACT_DIR. Return the delivered PPTX and no second PPTX.",
    "Presentation request:",
    JSON.stringify(request, null, 2),
  ].join("\n\n");
}

export function createPresentationDraft(value: unknown): ComposerDraft {
  const request = validatePresentationRequest(value);
  const prompt = buildPresentationPrompt(request);
  return {
    mode: "prompt",
    text: prompt,
    resolvedText: prompt,
    attachments: [],
    parts: [
      { type: "text", text: prompt },
      ...(request.currentFile ? [{ type: "file" as const, path: request.currentFile.path, label: request.currentFile.name }] : []),
    ],
  };
}

export function createPresentationTurnId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (!uuid) throw new Error("Secure presentation turn ID generation is unavailable.");
  return `msg_presentation_${uuid}`;
}
