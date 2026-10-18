import { resolve } from "node:path";
import { once } from "node:events";
import { timingSafeEqual } from "node:crypto";
import { hostFetch } from "@/utils/jugglework";
import { authorizeManagedDirectory, clearManagedDirectoryGrants, isManagedMode } from "@/lib/managed";

process.env.toonflowDesktop = "1";
const root = resolve(import.meta.dirname, "..");
const token = process.env.TOONFLOW_SESSION_TOKEN;
if (!isManagedMode() || !token || !process.env.TOONFLOW_BRIDGE_URL || !process.env.TOONFLOW_BRIDGE_TOKEN || !process.env.TOONFLOW_DATA_DIR) {
  throw new Error("JuggleWork 模块启动参数缺失");
}
const { createApp } = await import("./app");
const app = await createApp({
  webRoot: resolve(root, "web"), dataDirectory: process.env.TOONFLOW_DATA_DIR,
  toolsRoot: resolve(root, "tools"), nodesRoot: resolve(root, "nodes"), skillsRoot: resolve(root, "skills"),
  resourcesRoot: root, manifestPath: resolve(root, "build-manifest.json"), pluginRevision: "jugglework-managed-v1",
  authorize: (req, res, next) => {
    const actual = Buffer.from(req.get("x-toonflow-session") ?? ""), expected = Buffer.from(token);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { res.sendStatus(403); return; }
    if (req.path === "/health") { res.json({ ok: true }); return; }
    next();
  },
});
const { shutdown: shutdownFfmpeg } = await import("@/utils/ffmpeg");
async function desktop<T>(command: string, ...args: unknown[]): Promise<T> {
  const response = await hostFetch(`/desktop/${command}`, { args });
  return ((await response.json()) as { result: T }).result;
}
app.locals.desktop = {
  selectDirectory: async () => {
    const selected = await desktop<string | null>("selectDirectory");
    return selected ? authorizeManagedDirectory(selected) : null;
  },
  selectProviderFile: () => desktop("selectProviderFile"),
  selectSaveFile: (name: string) => desktop("selectSaveFile", name),
  saveFile: (token: string, data: Uint8Array) => desktop("saveFile", token, Buffer.from(data).toString("base64")),
  readClipboardText: () => desktop("readClipboardText"), writeClipboardText: (text: string) => desktop("writeClipboardText", text),
  ready: (failed?: boolean) => desktop("ready", failed), openDevTools: () => desktop("openDevTools"),
  openUrl: () => { throw new Error("请通过 JuggleWork 管理模块安装"); },
  updater: { getLocalInfo: async () => ({ version: "2.0", channel: "dev", hash: "6e6a008", baseUrl: "" }), updateInfo: () => ({}), checkForUpdate: async () => ({}) },
};
const restoredDirectories = await desktop<string[]>("directoryGrants");
for (const directory of restoredDirectories) await authorizeManagedDirectory(directory);
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") throw new Error("模块监听失败");
console.log(`TOONFLOW_READY=${address.port}`);
const parent = process.ppid;
let shutdownPromise: Promise<void> | undefined;
function shutdown() {
  shutdownPromise ??= (async () => {
    clearManagedDirectoryGrants();
    const closed = once(server, "close").catch(() => undefined);
    server.close();
    const ffmpegClosed = shutdownFfmpeg();
    server.closeAllConnections();
    await Promise.race([Promise.all([closed, ffmpegClosed]), new Promise(resolve => setTimeout(resolve, 2000))]);
    process.exit(0);
  })();
  return shutdownPromise;
}
setInterval(() => { if (process.ppid !== parent || process.ppid === 1) void shutdown(); }, 2000).unref();
process.once("SIGTERM", () => { void shutdown(); });
