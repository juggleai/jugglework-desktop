import type { UIMessage } from "ai";
import type { SessionFileArtifacts } from "@jugglework/types/file-artifacts";
import * as React from "react";

import {
  isApplyPatchToolPart,
  isEditToolPart,
  isWriteToolPart,
} from "@/lib/build-in-tools";
import { generatedImageResultFromToolPart } from "@/components/chat/generated-image-result";
import { generatedVideoJobFromToolPart } from "@/components/chat/generated-video-result";
import { useOpenTargets } from "@/lib/target-provider";
import { deriveOpenTargets, extractFilePathsFromText, isCollectibleArtifactTarget, isOpenableFileTarget, type OpenTarget, type OpenTargetPreview } from "@/react-app/domains/session/artifacts/open-target";
import { resolveFileReference } from "@/lib/file-references";
import { parseUnifiedDiff } from "@/react-app/domains/session/files/parse-unified-diff";

export type ArtifactType = "website" | "markdown" | "sheet" | "slides" | "document" | "image" | "video" | "audio" | "pdf" | "html" | "text" | "unknown";

export type ArtifactItem = {
  id: string
  name: string
  path: string
  type: ArtifactType
  messageId: string
  messageIndex: number
  updatedAt?: number
  sizeBytes?: number
  hasSuccessfulWrite?: boolean
  change?: { additions: number; deletions: number; patch: string; source?: "snapshot" | "edits" }
  legacy_target: OpenTarget
}

function changeRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function changeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Use turn snapshots, falling back to this turn's successful edit records only. */
export function artifactsWithTurnDiffs(artifacts: ArtifactItem[], message?: UIMessage, toolMessages: UIMessage[] = [], workspaceRoot = ""): ArtifactItem[] {
  const metadata = message?.metadata as { opencode?: { fileDiffs?: unknown } } | undefined;
  const summaryDiffs = metadata?.opencode?.fileDiffs;
  const root = normalizeArtifactPath(workspaceRoot).replace(/\/$/, "");
  const relativePath = (path: string) => {
    const normalized = normalizeArtifactPath(path);
    return root && normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
  };
  type RecordedChange = { file: string; patch: string; additions: number; deletions: number; status?: string; source: "snapshot" | "edits" };
  const fallback = new Map<string, RecordedChange>();
  const seen = new Set<string>();
  for (const message of toolMessages) for (const part of message.parts) {
    if (part.type !== "dynamic-tool" || part.state !== "output-available" || !["edit", "write", "apply_patch"].includes(part.toolName) || seen.has(part.toolCallId)) continue;
    seen.add(part.toolCallId);
    const tool = changeRecord(part.callProviderMetadata?.opencode?.toolMetadata);
    if (!tool) continue;
    const input = changeRecord(part.input);
    const files = Array.isArray(tool.files) ? tool.files : tool.filediff ? [tool.filediff] :
      typeof tool.diff === "string" && typeof input?.filePath === "string" ? [{ file: input.filePath, patch: tool.diff }] : [];
    for (const value of files) {
      const file = changeRecord(value);
      if (!file) continue;
      const rawPath = file.movePath || file.filePath || file.file || file.relativePath;
      if (typeof rawPath !== "string") continue;
      const path = relativePath(rawPath);
      // Remove each record's file headers before concatenating hunks. Otherwise
      // later ---/+++ headers would be rendered and counted as edited lines.
      const rawPatch = typeof file.patch === "string" ? file.patch : "";
      const hunkStart = rawPatch.search(/^@@ /m);
      const patch = hunkStart >= 0 ? rawPatch.slice(hunkStart) : rawPatch;
      const lines = parseUnifiedDiff(patch).flatMap((hunk) => hunk.lines);
      const additions = changeCount(file.additions) ?? lines.filter((line) => line.kind === "add").length;
      const deletions = changeCount(file.deletions) ?? lines.filter((line) => line.kind === "del").length;
      const previous = fallback.get(path);
      fallback.set(path, { file: path, patch: [previous?.patch, patch].filter(Boolean).join("\n"), additions: (previous?.additions ?? 0) + additions, deletions: (previous?.deletions ?? 0) + deletions, status: file.type === "delete" || file.status === "deleted" ? "deleted" : "modified", source: "edits" });
    }
  }
  // Authoritative turn snapshots override per-edit totals, including explicit zero changes.
  const diffs = new Map<string, RecordedChange>(fallback);
  if (Array.isArray(summaryDiffs)) for (const value of summaryDiffs) {
    const diff = changeRecord(value);
    if (typeof diff?.file !== "string") continue;
    const additions = changeCount(diff.additions), deletions = changeCount(diff.deletions);
    if (additions === undefined || deletions === undefined) continue;
    const path = relativePath(diff.file);
    diffs.set(path, { file: path, patch: typeof diff.patch === "string" ? diff.patch : "", additions, deletions, status: typeof diff.status === "string" ? diff.status : undefined, source: "snapshot" });
  }
  const result = new Map(artifacts.map((item) => {
    const path = relativePath(item.path);
    return [path, path === item.path ? item : { ...item, path }];
  }));
  for (const diff of diffs.values()) {
    if (!diff || typeof diff.file !== "string" || !diff.file.trim()) continue;
    const path = normalizeArtifactPath(diff.file);
    const previous = result.get(path);
    const type = getArtifactType(path);
    const name = getArtifactName(path);
    const patch = typeof diff.patch === "string" ? diff.patch : "";
    // A binary/unknown diff is not a zero-line text change.
    const change = (patch || diff.additions > 0 || diff.deletions > 0) && !/Binary files .* differ|GIT binary patch/.test(patch)
      && Number.isSafeInteger(diff.additions) && diff.additions >= 0
      && Number.isSafeInteger(diff.deletions) && diff.deletions >= 0
      ? { additions: diff.additions, deletions: diff.deletions, patch, source: diff.source } : undefined;
    result.set(path, {
      ...(previous ?? {
        id: `turn-diff:${message?.id}:${path}`, name, path, type,
        messageId: message?.id ?? "", messageIndex: -1, hasSuccessfulWrite: true,
        legacy_target: {
          id: `file:${path}`, kind: "file", value: path, name,
          preview: artifactTypeToPreview(type), confidence: 100, reason: "turn-diff",
          exists: diff.status !== "deleted",
        },
      }),
      ...(previous && diff.status === "deleted" ? { legacy_target: { ...previous.legacy_target, exists: false } } : {}),
      change,
    });
  }
  return [...result.values()];
}

/** 使用轮次快照显示名称和大小，使用文件当前身份打开，后续修改不覆写旧卡片。 */
export function artifactsFromDelivery(data: SessionFileArtifacts, turnId: string): ArtifactItem[] {
  const turn = data.turns.find((entry) => entry.turnId === turnId);
  if (!turn) return [];
  const files = new Map(data.files.map((file) => [file.artifactId, file]));
  return turn.items.flatMap((item) => {
    const file = files.get(item.artifactId);
    if (!file) return [];
    const type = getArtifactType(item.snapshot.name);
    return [{
      id: file.artifactId, name: item.snapshot.name, path: file.relativePath, type,
      messageId: turnId, messageIndex: -1, sizeBytes: item.snapshot.sizeBytes ?? undefined,
      updatedAt: item.snapshot.updatedAt ?? undefined, hasSuccessfulWrite: true,
      legacy_target: {
        id: file.artifactId, kind: "file" as const, value: file.relativePath, name: file.name,
        preview: artifactTypeToPreview(getArtifactType(file.name)), confidence: 100, reason: "turn-delivery",
        exists: file.exists, size: file.sizeBytes ?? undefined, updatedAt: file.updatedAt ?? undefined,
      },
    }];
  });
}

type ArtifactEntry = ArtifactItem & {
  sequence: number
}

type GetArtifactsOptions = {
  includeTargetFallbacks?: boolean
  deliverablesOnly?: boolean
  stableOrder?: boolean
}

const WORKSPACES_PREFIX_PATTERN = /^workspaces\/[^/]+\//i;
const WORKSPACE_ID_PREFIX_PATTERN = /^workspace\/(?:ws_[^/]+|\d+|[0-9a-f-]{6,})\//i;

export function isMarkdownPreviewSupported(extension: string) {
  return ["md", "markdown", "mdx"].includes(extension);
}

export function isSheetPreviewSupported(extension: string) {
  return ["csv", "tsv", "xlsx", "xls", "ods"].includes(extension);
}

export function isImagePreviewSupported(extension: string) {
  return ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(extension);
}

export function isPdfPreviewSupported(extension: string) {
  return ["pdf"].includes(extension);
}

export function isHtmlPreviewSupported(extension: string) {
  return ["html", "htm"].includes(extension);
}

export function isTextPreviewSupported(extension: string) {
  return ["txt", "log", "json", "jsonc", "yaml", "yml", "toml", "xml", "ts", "tsx", "js", "jsx", "css", "scss"].includes(extension);
}

export function isPreviewSupported(extension: string) {
  return isMarkdownPreviewSupported(extension) || isSheetPreviewSupported(extension) || isImagePreviewSupported(extension) || isPdfPreviewSupported(extension) || isHtmlPreviewSupported(extension) || isTextPreviewSupported(extension);
}

export function getArtifactType(filename: string): ArtifactType {
  const extension = getFileExtension(filename);

  if (!extension) {
    return "unknown";
  }

  if (["md", "markdown", "mdx", "rmd", "rst"].includes(extension)) {
    return "markdown";
  }

  if (["csv", "tsv", "xlsx", "xls", "xlsm", "xlsb", "ods", "numbers"].includes(extension)) {
    return "sheet";
  }

  if (["ppt", "pptx", "pptm", "pot", "potx", "odp", "key", "sxi"].includes(extension)) {
    return "slides";
  }

  if (["doc", "docx", "odt", "rtf", "pages"].includes(extension)) {
    return "document";
  }

  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif", "heic", "heif", "tif", "tiff"].includes(extension)) {
    return "image";
  }

  if (["mp4", "mov", "avi", "mkv", "webm", "wmv", "flv", "m4v", "ogv", "mpeg", "mpg", "3gp"].includes(extension)) {
    return "video";
  }

  if (["mp3", "wav", "flac", "aac", "ogg", "oga", "m4a", "wma", "opus", "aiff", "aif", "mid", "midi"].includes(extension)) {
    return "audio";
  }

  if (["pdf"].includes(extension)) {
    return "pdf";
  }

  if (["html", "htm", "xhtml"].includes(extension)) {
    return "html";
  }

  if (["txt", "log", "json", "jsonc", "json5", "yaml", "yml", "toml", "xml", "ini", "env", "ts", "tsx", "js", "jsx", "mjs", "cjs", "vue", "svelte", "css", "scss", "sass", "less", "py", "rb", "go", "rs", "java", "kt", "swift", "php", "c", "cpp", "h", "cs", "sql", "sh", "bash", "zsh"].includes(extension)) {
    return "text";
  }

  return "unknown";
}

function getFileExtension(filename: string) {
  return filename.split(".").pop()?.toLowerCase();
}

const ARTIFACT_TYPE_LABELS: Record<ArtifactType, string> = {
  website: "Website",
  markdown: "Markdown",
  sheet: "Spreadsheet",
  slides: "Slides",
  document: "Document",
  image: "Image",
  video: "Video",
  audio: "Audio",
  pdf: "PDF",
  html: "HTML",
  text: "Text",
  unknown: "File",
};

export function getArtifactTypeLabel(type: ArtifactType) {
  return ARTIFACT_TYPE_LABELS[type];
}

export function canPreviewArtifact(artifact: ArtifactItem) {
  return isCollectibleArtifactTarget(artifact.legacy_target);
}

export function canOpenArtifact(artifact: ArtifactItem) {
  return canPreviewArtifact(artifact) || isOpenableFileTarget(artifact.legacy_target);
}

/** 显示已确认文件，或历史成功写入后已缺失的文件；未知候选不作为完成产物。 */
export function canDisplayArtifact(artifact: ArtifactItem) {
  return artifact.legacy_target.exists === true
    || (artifact.legacy_target.exists === false && artifact.hasSuccessfulWrite === true);
}

function getArtifactName(path: string) {
  const segments = path.split(/[/\\]/);
  
  return segments[segments.length - 1] ?? path;
}

function normalizeArtifactPath(path: string) {
  return path
    .trim()
    .replace(/[\\]+/g, "/")
    .replace(/^\.\//, "")
    .replace(WORKSPACES_PREFIX_PATTERN, "")
    .replace(WORKSPACE_ID_PREFIX_PATTERN, "");
}

function artifactTypeToPreview(type: ArtifactType): OpenTargetPreview {
  if (type === "markdown") return "markdown";
  if (type === "sheet") return "sheet";
  if (type === "slides") return "slides";
  if (type === "document") return "document";
  if (type === "image") return "image";
  if (type === "video") return "video";
  if (type === "pdf") return "pdf";
  if (type === "html") return "html";
  if (type === "text") return "text";
  if (type === "website") return "browser";
  return "external";
}

function artifactPathMatchesTarget(path: string, targetValue: string) {
  const normalized = normalizeArtifactPath(path);
  const target = normalizeArtifactPath(targetValue);
  return normalized === target || normalized.endsWith(`/${target}`);
}

function openTargetFromArtifactPath(
  path: string,
  name: string,
  type: ArtifactType,
  verifiedTargets: OpenTarget[],
): OpenTarget {
  const normalized = normalizeArtifactPath(path);
  const id = `file:${normalized}`;
  const exact = verifiedTargets.find((target) => target.kind === "file" && normalizeArtifactPath(target.value) === normalized);
  const matches = verifiedTargets.filter((target) => target.kind === "file" && artifactPathMatchesTarget(normalized, target.value));
  // TIPS: 绝对路径可以映射回服务端相对路径，但同名候选必须唯一，不能取整个会话的第一个匹配。
  const verified = exact ?? (matches.length === 1 ? matches[0] : undefined);

  return verified ?? {
    id,
    kind: "file",
    value: normalized,
    name,
    preview: artifactTypeToPreview(type),
    confidence: 95,
    reason: "artifact",
  };
}

function parseApplyPatchPaths(patchText: string) {
  const paths: string[] = [];
  if (typeof patchText !== "string") return paths;

  for (const line of patchText.split("\n")) {
    if (line.startsWith("*** Add File:")) {
      paths.push(line.slice("*** Add File:".length).trim());
      continue;
    }

    if (line.startsWith("*** Update File:")) {
      paths.push(line.slice("*** Update File:".length).trim());
      continue;
    }

    if (line.startsWith("*** Move to:")) {
      paths.push(line.slice("*** Move to:".length).trim());
    }
  }

  return paths;
}

const ASSISTANT_ARTIFACT_MENTION_PATTERN = /\b(?:created|deliverable|exported|generated|saved|updated|wrote)\b|生成|创建|导出|保存|交付|更新/iu;
const FAILED_DELIVERY_PATTERN = /(?:未能|无法|未|不能).{0,8}(?:生成|创建|保存|导出)|(?:生成|创建|保存|导出).{0,8}失败|\b(?:failed|unable|could not|cannot)\b/iu;

/** 判断输出是否适合作为用户交付文件，源码和内部运行文件不自动计入。 */
export function isDeliverableArtifactPath(path: string): boolean {
  const normalized = normalizeArtifactPath(path);
  if (/(?:^|\/)(?:node_modules|\.git|\.opencode|\.cache|__pycache__)(?:\/|$)/.test(normalized)) return false;
  if (/^(?:src|vendor)\//.test(normalized)) return false;
  return !/\.(?:tsx?|jsx?|mjs|cjs|py|rb|go|rs|java|kt|swift|php|[ch]|cpp|cs|sh|bash|zsh|lock)$/i.test(normalized);
}

function getArtifactPathsFromText(text: string) {
  if (!ASSISTANT_ARTIFACT_MENTION_PATTERN.test(text) || FAILED_DELIVERY_PATTERN.test(text)) return [];
  return extractFilePathsFromText(text).filter((path) => getArtifactType(path) !== "unknown");
}

function getArtifactPathsFromMessage(message: UIMessage) {
  if (message.role !== "assistant") return [];
  const paths: (string | undefined)[] = [];

  for (const part of message.parts) {
    if (part.type === "text" && message.role === "assistant") {
      paths.push(...getArtifactPathsFromText(part.text));
      continue;
    }

    if (part.type === "source-document") {
      if (part.filename) {
        paths.push(part.filename);
      } else {
        paths.push(part.title);
      }
      continue;
    }

    if (part.type !== "dynamic-tool" || part.state !== "output-available") {
      continue;
    }

    const generatedImage = generatedImageResultFromToolPart(part);
    if (generatedImage) {
      paths.push(generatedImage.path);
      continue;
    }

    const generatedVideo = generatedVideoJobFromToolPart(part);
    if (generatedVideo?.artifact) {
      paths.push(generatedVideo.artifact.path);
      continue;
    }

    if (isWriteToolPart(part)) {
      paths.push(part.input.filePath);
      continue;
    }

    if (isEditToolPart(part)) {
      paths.push(part.input.filePath);
      continue;
    }
    if (isApplyPatchToolPart(part)) {
      paths.push(...parseApplyPatchPaths(part.input.patchText));
    }
  }

  return paths.flatMap((path) => {
    const normalized = path?.trim();
    return normalized ? [normalized] : [];
  });
}

function addArtifact(
  artifacts: Map<string, ArtifactEntry>,
  path: string,
  messageId: string,
  messageIndex: number,
  sequence: number,
  verifiedTargets: OpenTarget[],
  verifiedTarget?: OpenTarget,
) {
  const normalized = normalizeArtifactPath(path);
  const type = getArtifactType(normalized);
  const legacyTarget = verifiedTarget ?? openTargetFromArtifactPath(normalized, getArtifactName(normalized), type, verifiedTargets);
  const key = normalizeArtifactPath(legacyTarget.value);
  const name = legacyTarget.name;

  artifacts.set(key, {
    id: key,
    name,
    path: key,
    type,
    messageId,
    messageIndex,
    sequence: artifacts.get(key)?.sequence ?? sequence,
    updatedAt: legacyTarget.updatedAt,
    sizeBytes: legacyTarget.size,
    legacy_target: legacyTarget,
  });
}

/** 从指定消息范围提取产物候选；服务端已确认目标只用于匹配，不默认当作本轮输出。 */
export function getArtifactsFromMessages(messages: UIMessage[], openTargets: OpenTarget[] = [], options: GetArtifactsOptions = {}) {
  const artifacts = new Map<string, ArtifactEntry>();
  const writeOutcomes = new Map<string, boolean>();
  let sequence = 0;

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type !== "dynamic-tool" || !["output-available", "output-error"].includes(part.state)) continue;
      const paths = isWriteToolPart(part) || isEditToolPart(part)
        ? [part.input?.filePath]
        : isApplyPatchToolPart(part) ? parseApplyPatchPaths(part.input?.patchText) : [];
      for (const path of paths) {
        if (typeof path !== "string" || !path.trim()) continue;
        const target = openTargetFromArtifactPath(path, getArtifactName(path), getArtifactType(path), openTargets);
        writeOutcomes.set(normalizeArtifactPath(target.value), part.state === "output-available");
      }
    }
  }

  messages.forEach((message, messageIndex) => {
    for (const path of getArtifactPathsFromMessage(message)) {
      if (options.deliverablesOnly && !isDeliverableArtifactPath(path)) continue;
      const target = openTargetFromArtifactPath(path, getArtifactName(path), getArtifactType(path), openTargets);
      if (writeOutcomes.get(normalizeArtifactPath(target.value)) === false) continue;
      addArtifact(artifacts, path, message.id, messageIndex, sequence, openTargets);
      sequence += 1;
    }
  });

  if (options.includeTargetFallbacks ?? true) {
    const fallbackMessageId = messages[messages.length - 1]?.id ?? "open-target";
    for (const target of openTargets) {
      if (isOpenableFileTarget(target)) {
        addArtifact(artifacts, target.value, fallbackMessageId, messages.length, sequence, openTargets, target);
        sequence += 1;
      }
    }
  }

  return [...artifacts.values()].map((artifact) => ({
    ...artifact,
    hasSuccessfulWrite: writeOutcomes.get(artifact.path) === true,
  })).sort((left, right) => {
    if (options.stableOrder) return left.sequence - right.sequence;
    const updatedAtDelta = (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
    if (updatedAtDelta !== 0) return updatedAtDelta;

    const messageDelta = right.messageIndex - left.messageIndex;
    if (messageDelta !== 0) return messageDelta;

    return right.sequence - left.sequence;
  });
}

/** 按消息范围读取产物及服务端确认的元信息，调用方可启用交付过滤和稳定顺序。 */
export function useArtifacts(messages: UIMessage[], options: GetArtifactsOptions = {}) {
  const { openTargets } = useOpenTargets();
  const includeTargetFallbacks = options.includeTargetFallbacks ?? false;
  const deliverablesOnly = options.deliverablesOnly ?? false;
  const stableOrder = options.stableOrder ?? false;

  return React.useMemo(
    () => getArtifactsFromMessages(messages, openTargets, { includeTargetFallbacks, deliverablesOnly, stableOrder }),
    [includeTargetFallbacks, deliverablesOnly, stableOrder, messages, openTargets],
  );
}

/**
 * 正文引用独立于交付快照：本轮提及且服务端确认存在的文件均可打开。
 * @param messages 当前轮次消息，不混入其他轮次的同名引用
 * @param targets 服务端确认的文件目标
 * @param delivered 当前轮次权威交付，保留其文件身份
 */
export function getArtifactFileReferences(messages: UIMessage[], targets: OpenTarget[], delivered: ArtifactItem[]): OpenTarget[] {
  const candidates = deriveOpenTargets(messages, { includeFileMentions: true })
    .filter((target) => target.kind === "file" && isDeliverableArtifactPath(target.value))
    .flatMap((candidate) => {
      const target = resolveFileReference(candidate.value, targets)
        ?? openTargetFromArtifactPath(candidate.value, candidate.name, getArtifactType(candidate.value), targets);
      return target.exists === true ? [target] : [];
    });
  // TIPS: 普通引用不依赖“生成/保存”等交付措辞；只读引用不会因此登记为本轮产物。
  return [...new Map([...candidates, ...delivered.map((item) => item.legacy_target)]
    .filter((target) => target.exists === true)
    .map((target) => [target.value, target])).values()];
}

export function usePreviewArtifact() {
  const { onOpenTarget } = useOpenTargets();

  return React.useCallback((artifact: ArtifactItem) => {
    async function previewArtifact() {
      onOpenTarget?.(artifact.legacy_target);
    }

    void previewArtifact();
  }, [onOpenTarget]);
}
