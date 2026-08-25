import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const REMOTE_CONTROL_SETTINGS_VERSION = 1;

/** @type {Readonly<import("@jugglework/types/desktop-ipc").DesktopRemoteControlSettings>} */
export const disabledRemoteControlSettings = Object.freeze({
  schemaVersion: REMOTE_CONTROL_SETTINGS_VERSION,
  enabled: false,
  preventSleepWhileWaiting: false,
  backgroundMode: false,
  launchAtLogin: false,
  allowBusySessionSteer: false,
  allowBusySessionEnqueue: false,
});

/** @returns {import("@jugglework/types/desktop-ipc").DesktopRemoteControlSettings} */
export function normalizeRemoteControlSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...disabledRemoteControlSettings };
  }
  if (value.schemaVersion !== REMOTE_CONTROL_SETTINGS_VERSION) {
    return { ...disabledRemoteControlSettings };
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !["schemaVersion", "enabled", "preventSleepWhileWaiting", "backgroundMode", "launchAtLogin", "allowBusySessionSteer", "allowBusySessionEnqueue"].includes(key))) {
    return { ...disabledRemoteControlSettings };
  }
  if (
    typeof value.enabled !== "boolean" ||
    !(value.preventSleepWhileWaiting === undefined || typeof value.preventSleepWhileWaiting === "boolean") ||
    typeof value.backgroundMode !== "boolean" ||
    typeof value.launchAtLogin !== "boolean" ||
    typeof value.allowBusySessionSteer !== "boolean" ||
    typeof value.allowBusySessionEnqueue !== "boolean"
  ) {
    return { ...disabledRemoteControlSettings };
  }
  return {
    schemaVersion: REMOTE_CONTROL_SETTINGS_VERSION,
    enabled: value.enabled,
    // TIPS: 旧版本没有该字段。已启用设备迁移到产品要求的默认值；未启用记录仍保持完全关闭。
    preventSleepWhileWaiting: value.enabled && (value.preventSleepWhileWaiting ?? true),
    backgroundMode: value.enabled && value.backgroundMode,
    launchAtLogin: value.enabled && value.launchAtLogin,
    allowBusySessionSteer: value.enabled && value.allowBusySessionSteer,
    allowBusySessionEnqueue: value.enabled && value.allowBusySessionEnqueue,
  };
}

/**
 * @param {{
 *   app: { getPath(name: string): string } | null,
 *   filePath?: string,
 *   fileSystem?: Partial<Pick<typeof import("node:fs/promises"), "mkdir" | "readFile" | "rename" | "rm" | "writeFile">>
 * }} options
 */
export function createRemoteControlSettingsStore({ app, filePath, fileSystem = {} }) {
  const fs = {
    mkdir: fileSystem.mkdir ?? mkdir,
    readFile: fileSystem.readFile ?? readFile,
    rename: fileSystem.rename ?? rename,
    rm: fileSystem.rm ?? rm,
    writeFile: fileSystem.writeFile ?? writeFile,
  };
  const targetPath = filePath ?? path.join(app.getPath("userData"), "desktop-remote-control.json");
  const disabledMarkerPath = `${targetPath}.disabled`;
  /** @type {import("@jugglework/types/desktop-ipc").DesktopRemoteControlSettings} */
  let current = { ...disabledRemoteControlSettings };
  let loaded = false;
  let loadPromise = null;
  let operation = Promise.resolve();

  /**
   * @template T
   * @param {() => Promise<T>} work
   * @returns {Promise<T>}
   */
  function serialized(work) {
    const pending = operation.then(work, work);
    operation = pending.catch(() => undefined);
    return pending;
  }

  async function load() {
    if (loaded) return { ...current };
    if (!loadPromise) {
      loadPromise = (async () => {
        try {
          await fs.readFile(disabledMarkerPath, "utf8");
          current = { ...disabledRemoteControlSettings };
          loaded = true;
          return { ...current };
        } catch {}
        try {
          const raw = await fs.readFile(targetPath, "utf8");
          current = normalizeRemoteControlSettings(JSON.parse(raw));
        } catch {
          current = { ...disabledRemoteControlSettings };
        }
        loaded = true;
        return { ...current };
      })();
    }
    return loadPromise;
  }

  async function persist(next) {
    const normalized = normalizeRemoteControlSettings(next);
    const tempPath = `${targetPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      if (!normalized.enabled) {
        // The marker is written first and wins over the settings document on
        // every future read. A failed replacement can therefore never revive
        // an older enabled document after restart.
        await fs.writeFile(disabledMarkerPath, "disabled\n", { encoding: "utf8", mode: 0o600 });
      }
      await fs.writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
      await fs.rename(tempPath, targetPath);
      if (normalized.enabled) {
        await fs.rm(disabledMarkerPath, { force: true });
      }
      current = normalized;
      loaded = true;
      return { ...current };
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      // Remove any previously enabled document. If persistence is degraded,
      // absence is safer than allowing a stale opt-in to survive a restart.
      await fs.rm(targetPath, { force: true }).catch(() => undefined);
      current = { ...disabledRemoteControlSettings };
      loaded = true;
      throw error;
    }
  }

  async function update(input) {
    const record = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    if (Object.keys(record).some((key) => !["enabled", "preventSleepWhileWaiting", "backgroundMode", "launchAtLogin", "allowBusySessionSteer", "allowBusySessionEnqueue"].includes(key)) ||
      Object.values(record).some((value) => typeof value !== "boolean")) {
      throw new TypeError("Remote-control settings update is invalid.");
    }
    return serialized(async () => {
      const previous = await load();
      const nextEnabled = typeof record.enabled === "boolean" ? record.enabled : previous.enabled;
      return persist({
        schemaVersion: REMOTE_CONTROL_SETTINGS_VERSION,
        enabled: nextEnabled,
        preventSleepWhileWaiting:
          typeof record.preventSleepWhileWaiting === "boolean"
            ? record.preventSleepWhileWaiting
            : nextEnabled && !previous.enabled
              ? true
              : previous.preventSleepWhileWaiting,
        backgroundMode:
          typeof record.backgroundMode === "boolean" ? record.backgroundMode : previous.backgroundMode,
        launchAtLogin:
          typeof record.launchAtLogin === "boolean" ? record.launchAtLogin : previous.launchAtLogin,
        allowBusySessionSteer:
          typeof record.allowBusySessionSteer === "boolean" ? record.allowBusySessionSteer : previous.allowBusySessionSteer,
        allowBusySessionEnqueue:
          typeof record.allowBusySessionEnqueue === "boolean" ? record.allowBusySessionEnqueue : previous.allowBusySessionEnqueue,
      });
    });
  }

  return {
    filePath: targetPath,
    disabledMarkerPath,
    read: () => serialized(load),
    update,
    disable: () => serialized(() => persist(disabledRemoteControlSettings)),
  };
}
