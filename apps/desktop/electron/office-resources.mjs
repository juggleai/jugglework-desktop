import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import assets from "./office-assets.cjs";
import { createOfficeFonts } from "./office-fonts.mjs";
import { createOfficeNetworkPolicy } from "./office-network.mjs";
import { configureOfficePageResponse } from "./office-page-config.mjs";
import {
  fetchOfficePageResource,
  handleOfficeSaveRequest,
} from "./office-save-request.mjs";

/** 按来源和精确身份分类；未知本地资源保留原响应，在线资源统一受本地模式约束。 */
export function classifyOfficeResource(
  url,
  origin,
  manifest,
  destination = "",
) {
  const parsed = new URL(url);
  const entry = manifest.entries.find(
    (item) =>
      item.url === url ||
      (!item.url &&
        parsed.origin === origin &&
        parsed.pathname === item.path &&
        !parsed.search),
  );
  if (entry) return { kind: entry.kind, entry };
  const optional = manifest.optional.find(
    (item) => origin === parsed.origin && item.path === parsed.pathname,
  );
  if (optional) return { kind: "optional", entry: optional };
  if (
    parsed.origin !== origin &&
    (destination === "font" || /\.(?:woff2?|ttf|otf)$/i.test(parsed.pathname))
  )
    return { kind: "unknown-font" };
  if (parsed.origin === origin) {
    if (
      [
        "/static/doc/pc.html",
        "/static/sheet/pc.html",
        "/static/slide/pc.html",
      ].includes(parsed.pathname)
    )
      return { kind: "core" };
  }
  return { kind: parsed.origin === origin ? "unknown" : "online" };
}

/**
 * 创建桌面共享资源服务；每个页面保留独立 session，只有字体磁盘缓存共享。
 * @param {{assetsDirectory: string, cacheDirectory: string, fetch?: typeof globalThis.fetch}} options 安装资源及用户缓存目录
 */
export function createOfficeResources({
  assetsDirectory,
  cacheDirectory,
  fetch,
}) {
  const manifest = assets.readOfficeAssets(assetsDirectory);
  const fonts = createOfficeFonts({
    directory: cacheDirectory,
    assetsDirectory,
    entries: manifest.entries,
    fetch,
  });
  const listeners = new Set();
  const states = new Map();
  const publish = (id, state) => {
    states.set(id, state);
    for (const listener of listeners) listener(id, state);
  };
  return {
    /** 读取页面资源状态，不包含请求 URL、正文或文件路径。 */
    state(id) {
      return states.get(id) ?? { fontFailures: 0, coreFailures: 0 };
    },
    /** 订阅文档字体及必需资源状态变更。 */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /**
     * 为唯一 Office 页面注册 HTTP/HTTPS；返回与页面同寿命的清理器。
     * @param {{protocol: Pick<Electron.Protocol, 'handle' | 'unhandle'>, webRequest: Pick<Electron.WebRequest, 'onBeforeRequest'>, fetch: Electron.Session['fetch']}} partition 页面分区
     * @param {{documentId: string, origin: string, filePath: string, kind: string, selectionUi?: boolean, commit: {error: Error | null}, save: () => Promise<{engineFileId: string}>, onCoreFailure: () => void}} host 页面保存及故障归属
     */
    attach(partition, host) {
      const controller = new AbortController();
      const failures = { fonts: new Set(), core: new Set() };
      const attempted = new Set();
      const diagnostics = {
        optionalRequests: 0,
        unknownFailures: 0,
        blockedRequests: 0,
      };
      const network = createOfficeNetworkPolicy(host.origin, manifest.entries);
      const report = (kind, identity, failed) => {
        if (controller.signal.aborted) return;
        const set = kind === "font" ? failures.fonts : failures.core;
        if (failed) set.add(identity);
        else set.delete(identity);
        publish(host.documentId, {
          fontFailures: failures.fonts.size,
          coreFailures: failures.core.size,
          retryableFonts: fonts.entries.filter((entry) =>
            failures.fonts.has(entry.id),
          ).length,
        });
      };
      const rejectNetwork = (request) => {
        if (network.allows(request)) return false;
        diagnostics.blockedRequests++;
        const resource = classifyOfficeResource(
          request.url,
          host.origin,
          manifest,
          request.destination ?? request.resourceType,
        );
        if (resource.kind === "unknown-font") report("font", "unlisted", true);
        return true;
      };
      const handler = async (request) => {
        if (rejectNetwork(request))
          return new Response(null, {
            status: 410,
            headers: { "Cache-Control": "no-store" },
          });
        // TIPS: 保存/关闭及原生提交响应的拥有者不变，资源适配不能绕过宿主保护。
        const saved = await handleOfficeSaveRequest(request, host);
        if (saved) return saved;
        const resource = classifyOfficeResource(
          request.url,
          host.origin,
          manifest,
          request.destination,
        );
        if (
          resource.kind === "optional" &&
          ["GET", "POST"].includes(request.method)
        ) {
          diagnostics.optionalRequests++;
          return new Response(null, {
            status: 410,
            headers: { "Cache-Control": "no-store" },
          });
        }
        if (resource.kind === "font" && request.method !== "GET")
          return new Response(null, { status: 405 });
        if (
          request.method === "GET" &&
          resource.entry &&
          ["font", "core"].includes(resource.kind)
        ) {
          const entry = resource.entry;
          if (resource.kind === "font") {
            // 每页失败只尝试一次；显式重试只清理失败记录，绝不刷新模型或覆盖字体声明。
            if (attempted.has(entry.id) && failures.fonts.has(entry.id))
              return new Response(null, { status: 503 });
            attempted.add(entry.id);
            const result = await fonts.resolve(
              entry,
              AbortSignal.any([controller.signal, request.signal]),
            );
            if (result.error !== "cancelled")
              report("font", entry.id, !result.bytes);
            if (!result.bytes) return new Response(null, { status: 503 });
            return new Response(result.bytes, {
              headers: {
                "Content-Type": entry.mime,
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "no-store",
              },
            });
          }
          try {
            const bytes = await readFile(
              path.join(assetsDirectory, ...entry.file.split("/")),
            );
            if (
              bytes.length !== entry.size ||
              createHash("sha256").update(bytes).digest("hex") !== entry.sha256
            )
              throw new Error("Office 资源校验失败");
            return new Response(bytes, {
              headers: {
                "Content-Type": entry.mime,
                "Cache-Control": "no-cache",
              },
            });
          } catch (error) {
            if (entry.required && !controller.signal.aborted) {
              report("core", entry.id, true);
              queueMicrotask(() => {
                if (!controller.signal.aborted) host.onCoreFailure();
              });
            }
            return new Response(null, { status: 503 });
          }
        }
        try {
          const response = await fetchOfficePageResource(request, {
            ...host,
            fetch: (input) =>
              partition.fetch(input, {
                bypassCustomProtocolHandlers: true,
                redirect: "manual",
              }),
          });
          if (resource.kind === "core" && !response.ok) {
            report("core", new URL(request.url).pathname, true);
            if (!controller.signal.aborted)
              queueMicrotask(() => {
                if (!controller.signal.aborted) host.onCoreFailure();
              });
          }
          if (resource.kind === "unknown" && !response.ok)
            diagnostics.unknownFailures++;
          return await configureOfficePageResponse(request, response, host);
        } catch (error) {
          if (resource.kind === "unknown") diagnostics.unknownFailures++;
          if (resource.kind === "core" && !controller.signal.aborted) {
            report("core", new URL(request.url).pathname, true);
            queueMicrotask(() => {
              if (!controller.signal.aborted) host.onCoreFailure();
            });
          }
          throw error;
        }
      };
      // TIPS: 协议处理器不能覆盖 WebSocket/重定向，分区边界也必须在建立连接前执行同一策略。
      partition.webRequest.onBeforeRequest((request, callback) =>
        callback({ cancel: rejectNetwork(request) }),
      );
      let httpHandled = false;
      try {
        partition.protocol.handle("http", handler);
        httpHandled = true;
        partition.protocol.handle("https", handler);
      } catch (error) {
        if (httpHandled) partition.protocol.unhandle("http");
        partition.webRequest.onBeforeRequest(null);
        throw error;
      }
      publish(host.documentId, { fontFailures: 0, coreFailures: 0 });
      return {
        /** 预取当前失败字体，供下次打开或页面自身再次请求使用，不重建模型。 */
        async retry() {
          attempted.clear();
          let ready = false;
          for (const entry of fonts.entries) {
            if (!failures.fonts.has(entry.id)) continue;
            const result = await fonts.resolve(entry, controller.signal);
            ready ||= Boolean(result.bytes);
          }
          if (!controller.signal.aborted && ready)
            publish(host.documentId, {
              fontFailures: failures.fonts.size,
              coreFailures: failures.core.size,
              retryableFonts: fonts.entries.filter((entry) =>
                failures.fonts.has(entry.id),
              ).length,
              readyOnReopen: true,
            });
        },
        /** 关闭或故障时取消该页面字体下载并释放两个协议；迁移时不调用。 */
        dispose() {
          if (controller.signal.aborted) return;
          controller.abort();
          partition.protocol.unhandle("http");
          partition.protocol.unhandle("https");
          partition.webRequest.onBeforeRequest(null);
          states.delete(host.documentId);
          for (const listener of listeners) listener(host.documentId, null);
          if (
            diagnostics.optionalRequests ||
            diagnostics.unknownFailures ||
            diagnostics.blockedRequests
          )
            console.info("[office-resources]", {
              kind: host.kind,
              ...diagnostics,
            });
        },
      };
    },
  };
}
