import { afterEach, describe, expect, test } from "bun:test";
import {
  loadVendorScript,
  withTimeout,
} from "../src/react-app/domains/jugglechat/vendor-scripts";

const created: any[] = [];

function fakeDocument(existingNames: string[] = []) {
  const nodes = existingNames.map((name) => ({
    dataset: { jugglechatVendor: name },
    src: `/${name}`,
  }));
  const doc = {
    querySelector: (selector: string) => {
      const match = selector.match(/data-jugglechat-vendor="([^"]+)"/);
      return nodes.find((node) => node.dataset.jugglechatVendor === match?.[1]) ?? null;
    },
    createElement: () => {
      const listeners: Record<string, Array<() => void>> = {};
      const node: any = {
        dataset: {},
        src: "",
        async: false,
        addEventListener: (name: string, listener: () => void) => {
          (listeners[name] ??= []).push(listener);
        },
        emit: (name: string) => listeners[name]?.forEach((listener) => listener()),
      };
      created.push(node);
      return node;
    },
    head: {
      appendChild: (node: any) => {
        if (!doc.querySelector(`script[data-jugglechat-vendor="${node.dataset.jugglechatVendor}"]`)) {
          (doc as any).__nodes ??= [];
          (doc as any).__nodes.push(node);
        }
      },
    },
  } as any as Document & { __nodes?: any[] };
  (doc as any).__nodes = [...nodes];
  return doc;
}

afterEach(() => {
  created.length = 0;
});

describe("loadVendorScript", () => {
  test("已存在的标签不再等 load 事件，轮询到 ready 即结束", async () => {
    let ready = false;
    const promise = loadVendorScript({
      name: "aliyun-oss-sdk.js",
      src: "/vendor/aliyun-oss-sdk.js",
      ready: () => ready,
      doc: fakeDocument(["aliyun-oss-sdk.js"]),
      timeoutMs: 1_000,
      pollMs: 5,
    });
    setTimeout(() => { ready = true; }, 20);
    await expect(promise).resolves.toBeUndefined();
  });

  test("标签永远不就绪时按超时失败，而不是永久挂起", async () => {
    const started = Date.now();
    await expect(loadVendorScript({
      name: "tgs-player.js",
      src: "/vendor/tgs-player.js",
      ready: () => false,
      doc: fakeDocument(["tgs-player.js"]),
      timeoutMs: 60,
      pollMs: 5,
    })).rejects.toThrow("加载 tgs-player.js 超时");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("新脚本由 load 事件驱动，且 ready 为真才算成功", async () => {
    let ready = false;
    const doc = fakeDocument();
    const promise = loadVendorScript({
      name: "tgs-player.js",
      src: "/vendor/tgs-player.js",
      ready: () => ready,
      doc,
      timeoutMs: 1_000,
      pollMs: 5,
    });
    const script = created.at(-1);
    expect(script?.dataset.jugglechatVendor).toBe("tgs-player.js");
    ready = true;
    script?.emit("load");
    await expect(promise).resolves.toBeUndefined();
  });

  test("脚本加载失败立刻报错", async () => {
    const promise = loadVendorScript({
      name: "broken.js",
      src: "/vendor/broken.js",
      ready: () => false,
      doc: fakeDocument(),
      timeoutMs: 5_000,
      pollMs: 5,
    });
    created.at(-1)?.emit("error");
    await expect(promise).rejects.toThrow("无法加载 broken.js");
  });
});

describe("withTimeout", () => {
  test("原 Promise 按时完成时不改动结果", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 100, "timeout")).resolves.toBe("ok");
  });

  test("永不返回的 Promise 会抛出带说明的超时错误", async () => {
    await expect(withTimeout(new Promise(() => {}), 30, "IM 连接超时")).rejects.toThrow("IM 连接超时");
  });
});
