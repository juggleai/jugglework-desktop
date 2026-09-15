import type { VideoGenerationMode, VideoModelRef } from "@jugglework/types/media-generation";

export const VIDEO_JOB_STATUSES = [
  "queued", "submitting", "submitted", "running", "cancel_requested",
  "downloading", "completed", "failed", "cancelled",
] as const;

export type VideoJobStatus = (typeof VIDEO_JOB_STATUSES)[number];
export type VideoArtifact = {
  path: string;
  mimeType: string;
  bytes: number;
  durationSeconds?: number;
  width?: number;
  height?: number;
};

export type VideoGenerationJob = {
  id: string;
  workspaceId: string;
  sessionId?: string;
  clientRequestId: string;
  model: VideoModelRef;
  mode: VideoGenerationMode;
  status: VideoJobStatus;
  progress?: number;
  options: Record<string, unknown>;
  providerJobId?: string;
  nextPollAt?: number;
  pollAttempts: number;
  artifact?: VideoArtifact;
  error?: { code: string; message: string; retryable: boolean };
  revision: number;
  createdAt: number;
  updatedAt: number;
};

export const TERMINAL_VIDEO_JOB_STATUSES = new Set<VideoJobStatus>(["completed", "failed", "cancelled"]);

export type VideoAdapterSubmitInput = {
  jobId: string;
  clientRequestId: string;
  model: VideoModelRef;
  mode: VideoGenerationMode;
  prompt: string;
  sourceImagePath?: string;
  options: Record<string, unknown>;
};

export type VideoProviderJobState =
  | { status: "submitted" | "running"; progress?: number }
  | { status: "completed"; resultReference: string }
  | { status: "failed"; error: { code: string; message: string; retryable: boolean } }
  | { status: "cancelled" };

export interface VideoGenerationAdapter {
  readonly id: string;
  matches(model: VideoModelRef): boolean;
  submit(input: VideoAdapterSubmitInput, signal: AbortSignal): Promise<{ providerJobId: string }>;
  inspect(providerJobId: string, signal: AbortSignal): Promise<VideoProviderJobState>;
  cancel?(providerJobId: string, signal: AbortSignal): Promise<void>;
  acquireResult(resultReference: string, signal: AbortSignal): Promise<Response>;
}
