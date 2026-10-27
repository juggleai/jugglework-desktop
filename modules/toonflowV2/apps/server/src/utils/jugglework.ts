import type { MediaModel } from "@toonflow/tools-scaffold/runtime";
import { isManagedMode } from "@/lib/managed";

export const isJugglework = isManagedMode();

const maxConcurrentHostImageGenerations = 2;
let activeHostImageGenerations = 0;

type HostImageGenerationWaiter = {
  signal?: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (reason: unknown) => void;
  onAbort?: () => void;
};

const hostImageGenerationWaiters: HostImageGenerationWaiter[] = [];

function drainHostImageGenerationQueue() {
  while (activeHostImageGenerations < maxConcurrentHostImageGenerations && hostImageGenerationWaiters.length > 0) {
    const waiter = hostImageGenerationWaiters.shift()!;
    if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
    if (waiter.signal?.aborted) {
      waiter.reject(waiter.signal.reason);
      continue;
    }

    activeHostImageGenerations += 1;
    let released = false;
    waiter.resolve(() => {
      if (released) return;
      released = true;
      activeHostImageGenerations -= 1;
      drainHostImageGenerationQueue();
    });
  }
}

function acquireHostImageGeneration(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) return Promise.reject(signal.reason);

  return new Promise((resolve, reject) => {
    const waiter: HostImageGenerationWaiter = { signal, resolve, reject };
    waiter.onAbort = () => {
      const index = hostImageGenerationWaiters.indexOf(waiter);
      if (index === -1) return;
      hostImageGenerationWaiters.splice(index, 1);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", waiter.onAbort, { once: true });
    hostImageGenerationWaiters.push(waiter);
    drainHostImageGenerationQueue();
  });
}

type HostModel = {
  providerId: string; providerLabel: string; modelId: string; label: string;
  type: "text" | "image" | "video";
  protocol: "openai-completions" | "openai-responses" | "anthropic-messages";
  contextWindow?: number; maxOutputTokens?: number;
  image?: { textToImage?: boolean; imageToImage?: boolean; multiImageToImage?: boolean };
  video?: { protocol?: string; textToVideo?: boolean; imageToVideo?: boolean; outputVideo?: { maxDurationSeconds?: number; resolutions?: string[] } };
};

export async function hostFetch(path: string, body?: unknown, signal?: AbortSignal) {
  if (!process.env.TOONFLOW_BRIDGE_URL || !process.env.TOONFLOW_BRIDGE_TOKEN) throw new Error("JuggleWork 模型桥接未配置");
  const response = await fetch(`${process.env.TOONFLOW_BRIDGE_URL}${path}`, {
    method: body === undefined ? "GET" : "POST", signal,
    headers: { Authorization: `Bearer ${process.env.TOONFLOW_BRIDGE_TOKEN}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { message?: string; error?: { message?: string } | string };
    throw new Error(error.message || (typeof error.error === "object" ? error.error.message : error.error) || `JuggleWork 模型服务请求失败（${response.status}）`);
  }
  return response;
}

export async function hostModels(): Promise<HostModel[]> {
  const result = await (await hostFetch("/catalog")).json() as { models: HostModel[] };
  return result.models;
}

export async function hostTextProviders(providerId?: string, modelId?: string) {
  const providers = new Map<string, { id: string; label: string; apiUrl: string; apiKey: string; protocol: HostModel["protocol"]; models: { id: string; label: string; contextWindow?: number; maxOutputTokens?: number }[] }>();
  for (const model of await hostModels()) {
    if (model.type !== "text" || (providerId && model.providerId !== providerId) || (modelId && model.modelId !== modelId)) continue;
    if (!providers.has(model.providerId)) providers.set(model.providerId, {
      id: model.providerId, label: model.providerLabel, protocol: model.protocol,
      apiUrl: `${process.env.TOONFLOW_BRIDGE_URL}/model/${encodeURIComponent(model.providerId)}`,
      apiKey: process.env.TOONFLOW_BRIDGE_TOKEN!, models: [],
    });
    providers.get(model.providerId)!.models.push({ id: model.modelId, label: model.label, contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens });
  }
  return [...providers.values()];
}

export async function hostMediaModels(): Promise<MediaModel[]> {
  return (await hostModels()).filter(model => model.type !== "text").map(model => ({
    providerId: model.providerId, providerLabel: model.providerLabel, modelId: model.modelId, label: model.label,
    type: model.type as "image" | "video",
    ...(model.type === "video" ? { audio: false } : {}),
    mode: model.type === "video" ? [...(model.video?.textToVideo ? ["text"] : []), ...(model.video?.imageToVideo ? ["singleImage"] : [])]
      : [...(model.image?.textToImage ? ["text"] : []), ...(model.image?.imageToImage ? ["singleImage"] : []), ...(model.image?.multiImageToImage ? ["multiReference"] : [])],
    ...(model.video?.outputVideo ? { durationResolutionMap: [{ duration: Array.from({ length: Math.min(model.video.outputVideo.maxDurationSeconds ?? 10, 60) }, (_, i) => i + 1), resolution: model.video.outputVideo.resolutions ?? [] }] } : {}),
  }));
}

export async function hostMediaProvider(providerId: string, modelId: string, signal?: AbortSignal) {
  const model = (await hostModels()).find(model => model.providerId === providerId && model.modelId === modelId);
  if (!model) throw new Error("模型已不可用，请在 JuggleWork 设置中检查");
  async function invoke(operation: string, payload: Record<string, unknown> = {}, jobId?: string, requestSignal = signal) {
    return hostFetch("/invoke", { providerId, modelId, operation, payload, ...(jobId ? { jobId } : {}) }, requestSignal);
  }
  return {
    config: {}, rules: [],
    async generateImage(request: { prompt: string; images?: MediaInput[]; size?: string; ratio?: string }): Promise<MediaAsset[]> {
      const release = await acquireHostImageGeneration(signal);
      try {
        const references = request.images ?? [];
        if (references.some(reference => reference.type !== "base64")) throw new Error("JuggleWork 图片参考必须来自当前项目文件");
        const mode = references.length > 1 ? "multi-image-to-image" : references.length ? "image-to-image" : "text-to-image";
        const clientRequestId = crypto.randomUUID();
        const payload = {
          clientRequestId, prompt: request.prompt, mode,
          model: { providerID: providerId, modelID: modelId },
          references,
          ...(request.size ? { size: request.size } : {}),
        };
        const submitted = await (await invoke("image", payload)).json() as {
          job: { id: string; status: string; artifact?: { mimeType?: string }; error?: { message?: string } };
        };
        if (submitted.job.status !== "completed") throw new Error(submitted.job.error?.message || "图片生成结果不可用，JuggleWork 不会自动重试");
        if (!submitted.job.artifact?.mimeType?.startsWith("image/")) throw new Error("图片任务缺少已验证文件");
        const response = await invoke("image", {}, submitted.job.id);
        return [{ type: "binary", data: new Uint8Array(await response.arrayBuffer()), mediaType: "image", mimeType: response.headers.get("content-type") ?? submitted.job.artifact.mimeType }];
      } finally {
        release();
      }
    },
    async generateVideo(request: { prompt: string; images?: MediaInput[]; firstFrame?: MediaInput; lastFrame?: MediaInput; videos?: MediaInput[]; audios?: MediaInput[]; duration?: number; resolution?: string; ratio?: string; generateAudio?: boolean }): Promise<MediaAsset[]> {
      if (request.lastFrame || request.videos?.length || request.audios?.length) throw new Error("当前 JuggleWork 模型接口不支持尾帧、视频或音频参考");
      if (request.generateAudio) throw new Error("当前 JuggleWork 视频接口不支持生成音频");
      const sources = request.firstFrame ? [request.firstFrame] : request.images ?? [];
      if (sources.length > 1) throw new Error("当前 JuggleWork 视频接口只支持一张参考图片");
      const mode = sources.length ? "image-to-video" : "text-to-video";
      const payload = {
        clientRequestId: crypto.randomUUID(), prompt: request.prompt, mode,
        model: { providerID: providerId, modelID: modelId },
        ...(sources[0] ? { source: sources[0] } : {}),
        ...(request.duration == null ? {} : { durationSeconds: request.duration }),
        ...(request.resolution ? { resolution: request.resolution } : {}),
      };
      let jobId = "";
      let cancelRequested = false;
      const cancel = () => {
        if (!jobId || cancelRequested) return;
        cancelRequested = true;
        void invoke("videoCancel", {}, jobId, AbortSignal.timeout(10_000)).catch(() => undefined);
      };
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        const submitted = await (await invoke("video", payload)).json() as { job: { id: string } };
        jobId = submitted.job.id;
        if (signal?.aborted) { cancel(); signal.throwIfAborted(); }
        const deadline = Date.now() + 30 * 60_000;
        while (Date.now() < deadline) {
          signal?.throwIfAborted();
          const result = await (await invoke("videoStatus", {}, jobId)).json() as { job: { status: string; artifact?: { mimeType?: string }; error?: { message?: string } } };
          if (["failed", "cancelled", "submission_unknown"].includes(result.job.status)) throw new Error(result.job.error?.message || "视频生成失败");
          if (result.job.status === "completed") {
            if (!result.job.artifact?.mimeType?.startsWith("video/")) throw new Error("视频任务缺少已验证文件");
            const response = await invoke("videoContent", {}, jobId);
            return [{ type: "binary", data: new Uint8Array(await response.arrayBuffer()), mediaType: "video", mimeType: response.headers.get("content-type") ?? result.job.artifact.mimeType }];
          }
          await new Promise<void>((resolve, reject) => {
            const abort = () => { clearTimeout(timer); reject(signal?.reason); };
            const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, 3000);
            signal?.addEventListener("abort", abort, { once: true });
          });
        }
        throw new Error("视频生成等待超时，请检查 JuggleWork 任务状态");
      } finally {
        signal?.removeEventListener("abort", cancel);
      }
    },
    generateAudio: undefined,
  };
}
