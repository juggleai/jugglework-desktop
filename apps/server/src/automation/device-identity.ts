import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir, readJsonFile, shortId } from "../utils.js";
import { runtimeStorageDir } from "../runtime-db.js";
import type { ServerConfig } from "../types.js";

/**
 * apps/server 自己的、跟渲染进程 `automation.device-id.v1`（localStorage，活在另一个
 * 进程里）无关的稳定安装标识——事件触发自动化的轮询/认领/订阅注册/写回授权这几个调用
 * 统一用它当调用方自报的路由 key。
 *
 * TIPS：jugglework-server 这几个端点已经从"远程控制 agent token"降级成"session + 自报
 * deviceId"（见该仓库 design.md 决策 12）——deviceId 不再是安全边界，只是"这条投递/订阅
 * 归哪个安装"的路由 key，所以这里不需要跟渲染进程的 executorDeviceId 是同一个值，也不
 * 需要走远程控制的设备 enrollment，本地生成一个、持久化下来、重启后复用即可。
 */

type DeviceIdentityFile = { deviceId: string };

function deviceIdentityPath(config: ServerConfig): string {
  return join(runtimeStorageDir(config), "automation-device-id.json");
}

let cached: string | null = null;

/** 读取（必要时铸造并持久化）这台 apps/server 安装的事件中继路由 deviceId。 */
export async function readAutomationDeviceId(config: ServerConfig): Promise<string> {
  if (cached) return cached;
  const path = deviceIdentityPath(config);
  const existing = await readJsonFile<DeviceIdentityFile>(path);
  if (existing?.deviceId?.trim()) {
    cached = existing.deviceId.trim();
    return cached;
  }
  const deviceId = shortId();
  await ensureDir(runtimeStorageDir(config));
  await writeFile(path, JSON.stringify({ deviceId } satisfies DeviceIdentityFile), "utf8");
  cached = deviceId;
  return deviceId;
}

/** 仅供测试重置内存缓存，避免同进程内多个测试互相污染。 */
export function __resetAutomationDeviceIdCacheForTests(): void {
  cached = null;
}
