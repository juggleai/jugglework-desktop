/**
 * jugglechat 静态依赖脚本的加载器，以及"永不返回"等待点的统一超时。
 *
 * 这两类工具单独成文件是为了避免 import 体积巨大的 IM vendor SDK，
 * 同时让超时/轮询行为可以被单元测试直接覆盖。
 */

export const VENDOR_SCRIPT_TIMEOUT_MS = 10_000;
export const IM_INIT_TIMEOUT_MS = 25_000;
export const IM_CONNECT_TIMEOUT_MS = 20_000;

/** 给没有内建超时的 Promise 加一个可读的失败出口。 */
export function withTimeout<T>(
  promise: PromiseLike<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.resolve(promise);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function loadVendorScript(options: {
  name: string;
  src: string;
  ready: () => boolean;
  doc?: Document;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<void> {
  const { name, src, ready } = options;
  if (ready()) return Promise.resolve();
  const doc = options.doc ?? document;
  const timeoutMs = options.timeoutMs ?? VENDOR_SCRIPT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? 50;
  const existing = doc.querySelector<HTMLScriptElement>(
    `script[data-jugglechat-vendor="${name}"]`,
  );
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let poll: ReturnType<typeof setInterval> | null = null;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (poll) clearInterval(poll);
      if (deadline) clearTimeout(deadline);
      if (error) reject(error);
      else resolve();
    };
    // TIPS: 已存在的标签可能早已 load 完，load 事件不会再触发。只等事件会让
    // initialize() 永久 pending、消息页一直停在"正在初始化"，所以统一轮询 ready()
    // 并设置截止时间；新插入的脚本仍先用事件快速收敛。
    poll = setInterval(() => {
      if (ready()) settle();
    }, pollMs);
    deadline = setTimeout(() => settle(new Error(`加载 ${name} 超时`)), timeoutMs);
    if (existing) return;
    const script = doc.createElement("script");
    script.src = src;
    script.async = false;
    script.dataset.jugglechatVendor = name;
    script.addEventListener("load", () => {
      if (ready()) settle();
    }, { once: true });
    script.addEventListener("error", () => settle(new Error(`无法加载 ${name}`)), { once: true });
    doc.head.appendChild(script);
  });
}
