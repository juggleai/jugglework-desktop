/**
 * Which attachment media types can be sent to the model as file parts.
 *
 * Providers (via opencode + the AI SDK) accept images, PDFs, and text.
 * Anything else (e.g. Keynote `application/x-iwork-keynote-sffkey`) is
 * rejected by the provider with an UnsupportedFunctionalityError
 * — and because the file part lives in server-side session history, every
 * later message in the session replays the failure. Blocking these at attach
 * time prevents poisoning the session.
 *
 * Empty / `application/octet-stream` types are allowed: browsers report them
 * for plain source/code files, which are sent as `text/plain`.
 */
export function isModelReadableAttachment(mimeType: string) {
  const mime = mimeType.toLowerCase();
  if (mime === "" || mime === "application/octet-stream") return true;
  if (mime.startsWith("image/") || mime.startsWith("text/")) return true;
  if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return true;
  if (mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation") return true;
  if (mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return true;
  if (mime === "application/pdf" || mime === "application/json") return true;
  return mime.endsWith("+json") || mime.endsWith("+xml") || mime === "application/xml" || mime === "application/javascript";
}

/** Explicit image capability check; unknown model metadata is not treated as vision support. */
export function modelSupportsImageInput(model: unknown) {
  if (!model || typeof model !== "object") return false;
  const value = model as { attachment?: boolean; modalities?: { input?: unknown } };
  if (value.attachment === true) return true;
  return Array.isArray(value.modalities?.input) && value.modalities.input.includes("image");
}
