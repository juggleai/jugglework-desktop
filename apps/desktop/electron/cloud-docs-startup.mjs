import { randomUUID } from "node:crypto";

const otherRoutes = new Set(["trash", "settings", "collection", "tag", "journal", "journals", "favorites", "recent"]);

/** 从实际 Workspace 路由提取允许观测的产品目标。 */
export function cloudDocsContentTarget(href, origin) {
  try {
    const url = new URL(href);
    const match = /^\/workspace\/([\w-]{1,128})\/([\w-]{1,128})\/?$/.exec(url.pathname);
    if (url.origin !== origin || !match || otherRoutes.has(match[2])) return null;
    return match[2] === "all"
      ? { targetKind: "home", workspaceId: match[1], docId: null }
      : { targetKind: "document", workspaceId: match[1], docId: match[2] };
  } catch { return null; }
}

function sameTarget(a, b) {
  return a.targetKind === b.targetKind && a.workspaceId === b.workspaceId && a.docId === b.docId;
}

function validDuration(value) {
  return Number.isFinite(value) && value >= 0 && value <= 120_000 ? Math.round(value) : undefined;
}

/** @typedef {{instanceId:string,contextId:string,observationId:string,targetKind:string,workspaceId:string,docId:string|null}} CloudDocsObservationRequest */

/**
 * 为每个原生视图保留一次启动样本及一个正文观测。
 * @param {{instanceId:string,send:(request:CloudDocsObservationRequest)=>void,record:(sample:object)=>void,launchMs?:number,now?:()=>number,startedAt?:number,timeoutMs?:number,path?:string,workTiming?:{runtimeConfigMs?:number,launchRequestMs?:number}}} options
 */
export function createCloudDocsStartup({
  instanceId, send, record, launchMs, now = () => performance.now(), startedAt = now(), timeoutMs = 5_000,
  path = "bootstrap", workTiming,
}) {
  const launch = validDuration(launchMs);
  const runtimeConfigMs = validDuration(workTiming?.runtimeConfigMs);
  const launchRequestMs = validDuration(workTiming?.launchRequestMs);
  let commandReadyMs;
  let firstVisibleMs;
  let contentPresentableMs;
  let observation;
  let finished = false;

  function finish(outcome, format) {
    if (finished) return;
    finished = true;
    record({
      path,
      outcome,
      ...(format ? { format } : {}),
      ...(launch !== undefined ? { launchMs: launch } : {}),
      ...(runtimeConfigMs !== undefined ? { runtimeConfigMs } : {}),
      ...(launchRequestMs !== undefined ? { launchRequestMs } : {}),
      ...(commandReadyMs !== undefined ? { commandReadyMs } : {}),
      ...(firstVisibleMs !== undefined ? { firstVisibleMs } : {}),
      ...(contentPresentableMs !== undefined ? { contentPresentableMs } : {}),
      nativeElapsedMs: Math.round(now() - startedAt),
    });
  }

  function cancel(outcome = "cancelled") {
    if (observation) clearTimeout(observation.timer);
    observation = undefined;
    finish(outcome);
  }

  return {
    cancel,
    visible() {
      firstVisibleMs ??= Math.round(now() - startedAt);
      if (observation?.format) finish("presentable", observation.format);
    },
    ready(contextId, target, supported) {
      if (!target) {
        if (observation) cancel();
        return;
      }
      commandReadyMs ??= Math.round(now() - startedAt);
      if (!supported) {
        cancel("unsupported");
        return;
      }
      if (typeof contextId !== "string" || !contextId || contextId.length > 128) {
        cancel("unavailable");
        return;
      }
      if (observation?.request.contextId === contextId && sameTarget(observation.request, target)) return;
      if (observation) cancel();
      const request = { instanceId, contextId, observationId: randomUUID(), ...target };
      const timer = setTimeout(() => {
        if (observation?.request !== request) return;
        observation.terminal = true;
        finish("unavailable");
      }, timeoutMs);
      timer.unref?.();
      observation = { request, timer, terminal: false };
      send(request);
    },
    receive(message, actualTarget) {
      if (!observation || observation.terminal || !actualTarget) return;
      const { request } = observation;
      if (message.instanceId !== request.instanceId || message.contextId !== request.contextId ||
        message.observationId !== request.observationId || !sameTarget(request, message) ||
        !sameTarget(request, actualTarget)) return;
      const validFormat = request.targetKind === "home"
        ? message.format === "home"
        : ["document", "sheet", "presentation"].includes(message.format);
      if (message.state === "presentable" && !validFormat) return;
      if (!["loading", "presentable", "error"].includes(message.state)) return;
      clearTimeout(observation.timer);
      if (message.state === "loading") return;
      observation.terminal = true;
      if (message.state === "presentable") {
        contentPresentableMs ??= Math.round(now() - startedAt);
        observation.format = message.format;
        if (firstVisibleMs !== undefined) finish("presentable", message.format);
        return true;
      } else finish("error", validFormat ? message.format : undefined);
    },
  };
}
