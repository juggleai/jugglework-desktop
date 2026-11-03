function validItem(item, deviceEpoch, expectedSequence) {
  return item && item.deviceEpoch === deviceEpoch && item.sequence === expectedSequence &&
    typeof item.eventId === "string" && typeof item.workspaceId === "string" &&
    typeof item.sessionId === "string" && typeof item.runId === "string" &&
    Number.isSafeInteger(item.generation) && Number.isSafeInteger(item.revision) &&
    ["running", "completed", "failed", "aborted"].includes(item.status) &&
    typeof item.title === "string" && Number.isFinite(item.occurredAt);
}

/** Durable runtime feed delivery. It intentionally has no workspace or phone binding dependency. */
export function createRuntimeLifecycleFeedPump({ runtimeClient, publish, getConsumerId, signal, timers = globalThis,
  intervalMs = 1_000, logger = /** @type {{warn?: Function}} */ ({}) }) {
  if (!runtimeClient || typeof runtimeClient.getJson !== "function" || typeof runtimeClient.postJson !== "function" ||
      typeof publish !== "function" || typeof getConsumerId !== "function" || !signal) throw new TypeError("Lifecycle feed pump dependencies are invalid.");
  let timer = null;
  let running = false;
  const wait = () => new Promise((resolve) => { timer = timers.setTimeout(resolve, intervalMs); });
  signal.addEventListener("abort", () => { if (timer !== null) timers.clearTimeout(timer); }, { once: true });

  async function tick() {
    if (running || signal.aborted) return;
    running = true;
    try {
      const consumerId = getConsumerId();
      if (typeof consumerId !== "string" || !consumerId) return;
      const page = await runtimeClient.getJson(`/session-lifecycle/feed?consumerId=${encodeURIComponent(consumerId)}&limit=100&wait=1000`, { signal });
      if (!page || typeof page.deviceEpoch !== "string" || !Number.isSafeInteger(page.nextSequence) || !Array.isArray(page.items))
        throw new Error("invalid_lifecycle_page");
      let expected = page.nextSequence;
      for (const item of page.items) {
        if (signal.aborted) return;
        if (!validItem(item, page.deviceEpoch, expected)) throw new Error("invalid_lifecycle_item");
        const accepted = await publish({
          ...item,
          occurredAt: new Date(item.occurredAt).toISOString(),
          workspaceName: "",
        }, { isCurrent: () => !signal.aborted });
        if (!accepted || signal.aborted) return;
        await runtimeClient.postJson("/session-lifecycle/feed/ack", {
          consumerId, deviceEpoch: item.deviceEpoch, sequence: item.sequence, eventId: item.eventId,
        }, { signal });
        expected += 1;
      }
    } catch (error) {
      if (!signal.aborted) {
        try { logger.warn?.("runtime_lifecycle_feed_retry", { reason: error?.code ?? error?.message ?? "failed" }); } catch {}
      }
    } finally {
      running = false;
    }
  }

  void (async () => {
    while (!signal.aborted) {
      await tick();
      if (!signal.aborted) await wait();
    }
  })();
  return Object.freeze({ tick });
}
