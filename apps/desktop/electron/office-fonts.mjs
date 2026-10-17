import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const signature = (bytes) =>
  ["wOFF", "wOF2", "OTTO"].includes(bytes.subarray(0, 4).toString("ascii")) ||
  bytes.subarray(0, 4).equals(Buffer.from([0, 1, 0, 0]));
const valid = (bytes, entry) =>
  bytes.length === entry.size &&
  signature(bytes) &&
  createHash("sha256").update(bytes).digest("hex") === entry.sha256;

/**
 * 创建跨文档、窗口及重启复用的字体供应器；不写安装目录，不转发页面请求中的 Cookie 或正文。
 * @param {{directory: string, assetsDirectory: string, entries: any[], fetch?: typeof globalThis.fetch, timeoutMs?: number, budget?: number}} options 字体缓存及经过清单校验的来源
 */
export function createOfficeFonts({
  directory,
  assetsDirectory,
  entries,
  fetch = globalThis.fetch,
  timeoutMs = 5000,
  budget = 256 * 1024 * 1024,
}) {
  let online = true;
  let initialization;
  const active = new Map();
  const downloads = new Set();
  const settingsPath = path.join(directory, "settings.json");
  const cachePath = (entry) => path.join(directory, `${entry.sha256}.font`);
  const loadSettings = () =>
    (initialization ??= (async () => {
      try {
        online =
          JSON.parse(await readFile(settingsPath, "utf8")).online !== false;
      } catch (error) {
        // TIPS: 损坏偏好不能导致离线缓存不可读，也不能擅自重新开启用户可能已关闭的联网。
        if (error.code !== "ENOENT") online = false;
      }
      // TIPS: 单一资源服务首次下载前回收上次进程中断的临时文件，避免清理当前请求的写入。
      const names = await readdir(directory).catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return [];
      });
      for (const name of names) {
        if (/^(?:settings|[a-f0-9]{64})\.[a-f0-9-]{36}\.tmp$/.test(name))
          await rm(path.join(directory, name), { force: true });
      }
    })());
  const read = async (entry) => {
    for (const file of [
      entry.file && path.join(assetsDirectory, ...entry.file.split("/")),
      cachePath(entry),
    ].filter(Boolean)) {
      try {
        const info = await stat(file);
        if (info.size !== entry.size) {
          if (file === cachePath(entry)) await rm(file, { force: true });
          continue;
        }
        const bytes = await readFile(file);
        if (valid(bytes, entry)) return bytes;
        if (file === cachePath(entry)) await rm(file, { force: true });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return null;
  };
  const prune = async () => {
    const files = [];
    for (const name of await readdir(directory)) {
      if (!/^[a-f0-9]{64}\.font$/.test(name)) continue;
      const file = path.join(directory, name);
      const info = await stat(file).catch(() => null);
      if (info) files.push({ file, name, size: info.size, time: info.mtimeMs });
    }
    let total = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files.sort((a, b) => a.time - b.time)) {
      if (total <= budget) break;
      if (active.has(file.name.slice(0, -5))) continue;
      await rm(file.file, { force: true });
      total -= file.size;
    }
  };
  /** 仅读取清单内字体，失败返回真实原因，由页面自身执行字体替代。 */
  const resolve = async (entry, signal) => {
    try {
      await loadSettings();
      signal?.throwIfAborted();
      const cached = await read(entry);
      if (cached) return { bytes: cached, source: "local" };
      if (!online) return { error: "offline" };
      // TIPS: 只复制固定 URL，不复用浏览器 Request；重定向也不能把静态下载变成账号请求。
      const controller = new AbortController();
      downloads.add(controller);
      const stop = () => controller.abort();
      signal?.addEventListener("abort", stop, { once: true });
      active.set(entry.sha256, (active.get(entry.sha256) ?? 0) + 1);
      const timer = setTimeout(stop, timeoutMs);
      let temporary;
      try {
        signal?.throwIfAborted();
        const response = await fetch(entry.url, {
          signal: controller.signal,
          redirect: "error",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          headers: { Accept: entry.mime },
        });
        if (
          !response.ok ||
          (response.headers.get("content-length") &&
            Number(response.headers.get("content-length")) !== entry.size)
        ) {
          await response.body?.cancel();
          throw new Error("font-response");
        }
        // TIPS: 在分配完整响应前按清单限制流量，不能只在 arrayBuffer 之后检查大小。
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body ?? []) {
          size += chunk.length;
          if (size > entry.size) throw new Error("font-size");
          chunks.push(chunk);
        }
        const bytes = Buffer.concat(chunks, size);
        if (!valid(bytes, entry)) throw new Error("font-integrity");
        controller.signal.throwIfAborted();
        await mkdir(directory, { recursive: true });
        temporary = path.join(directory, `${entry.sha256}.${randomUUID()}.tmp`);
        await writeFile(temporary, bytes, { flag: "wx" });
        // Windows 不覆盖另一个已经完成的有效目标；重复下载也只提交同一内容身份。
        if (!(await read(entry))) await rename(temporary, cachePath(entry));
        await prune();
        return { bytes, source: "network" };
      } finally {
        clearTimeout(timer);
        controller.abort();
        downloads.delete(controller);
        signal?.removeEventListener("abort", stop);
        const count = active.get(entry.sha256) - 1;
        if (count) active.set(entry.sha256, count);
        else active.delete(entry.sha256);
        if (temporary) await rm(temporary, { force: true });
      }
    } catch (error) {
      return { error: signal?.aborted ? "cancelled" : "unavailable" };
    }
  };
  return {
    resolve,
    /** 读取字体联网偏好；缺少设置时默认允许目录内静态字体。 */
    async settings() {
      await loadSettings();
      return { online };
    },
    /** 保存联网偏好；两种宿主共用，禁用不删除已验证缓存。 */
    async setOnline(value) {
      if (typeof value !== "boolean") throw new Error("字体联网设置无效");
      await loadSettings();
      await mkdir(directory, { recursive: true });
      const temporary = path.join(directory, `settings.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify({ online: value }), {
          flag: "wx",
        });
        await rename(temporary, settingsPath);
        online = value;
        if (!online) for (const controller of downloads) controller.abort();
      } finally {
        await rm(temporary, { force: true });
      }
      return { online };
    },
    entries: entries.filter((entry) => entry.kind === "font"),
  };
}
