// Adapted from Toonflow v2.0.8 (MIT, Copyright (c) 2026 HBAI-Ltd).
// Host-owned operations replace the unrestricted upstream FFmpeg factory.
import { inject } from "vue";
import type { WorkspaceFiles } from "@toonflow/nodes-scaffold/runtime";

export type MediaResult = {
  source: string; operation: string; duration: number; width: number; height: number; hasAudio: boolean;
  manifest: string; video?: string; audio?: string;
  scenes: { index: number; start: number; end: number; video: string; image: string }[];
};
export type MediaRequest = { directory: string; path: string } & (
  { operation: "probe" } |
  { operation: "extractAudio" | "separate"; outputDirectory: string } |
  { operation: "trim"; outputDirectory: string; start: number; end: number } |
  { operation: "analyze"; outputDirectory: string; threshold: number; minSceneSeconds: number }
);
export type ProcessMedia = (request: MediaRequest, signal: AbortSignal) => Promise<MediaResult>;

export function useMediaProcessing() {
  const process = inject<ProcessMedia | undefined>("processMedia", undefined);
  return (request: MediaRequest, signal: AbortSignal) => {
    if (!process) throw new Error("当前画布未提供受限媒体处理能力");
    return process(request, signal);
  };
}

export async function createOutputDirectory(files: WorkspaceFiles) {
  await files.mkdir("assets").catch(error => { if (error?.response?.data?.data?.code !== "EEXIST") throw error; });
  const directory = `assets/${crypto.randomUUID()}`;
  await files.mkdir(directory);
  return directory;
}
