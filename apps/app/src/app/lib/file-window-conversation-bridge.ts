import type { FileWindowBridge } from "@jugglework/types/file-window";

/** 把 preload 推送变为 SDK 已有的 SSE 消费输入，取消时同步释放订阅。 */
export function fileWindowEventResponse(bridge: Pick<FileWindowBridge, "subscribeSessionEvents">, signal?: AbortSignal | null, onConnected?: () => void): Response {
  const subscribe = bridge.subscribeSessionEvents;
  if (!subscribe) throw new Error("File-window session event bridge is unavailable.");
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let closed = false;
  let closeStream: (() => void) | undefined;
  const dispose = () => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener("abort", dispose);
    unsubscribe?.();
    closeStream?.();
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      closeStream = () => controller.close();
      if (signal?.aborted) { dispose(); return; }
      signal?.addEventListener("abort", dispose, { once: true });
      try {
        unsubscribe = subscribe((event) => {
          if (closed) return;
          if (event.type === "server.connected") onConnected?.();
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        });
        if (closed) unsubscribe();
      } catch (error) {
        signal?.removeEventListener("abort", dispose);
        closed = true;
        controller.error(error);
      }
    },
    cancel() { closeStream = undefined; dispose(); },
  });
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}
