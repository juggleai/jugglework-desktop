import { readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveDesktopUpdateFeed } from "../dist/runtime/desktop-update-feed.js";

const ELECTRON_UPDATER_CHANNEL_FILENAME = "electron-updater-channel.v1.json";
const WINDOWS_UPDATE_ARCHITECTURES = ["x64", "arm64"];
const WINDOWS_UPDATE_ORIGIN = "https://downloads.jugglechat.cn";

// In dev mode, app.getVersion() returns the Electron framework version
// (e.g. "35.7.5") instead of the JuggleWork app version. Read from
// package.json so the UI always shows the correct version.
const __updater_dirname = path.dirname(fileURLToPath(import.meta.url));
let _cachedAppVersion = null;
function resolveAppVersion(app) {
  if (_cachedAppVersion) return _cachedAppVersion;
  const electronVersion = app.getVersion();
  // If packaged, app.getVersion() is correct (set by electron-builder).
  if (app.isPackaged) {
    _cachedAppVersion = electronVersion;
    return electronVersion;
  }
  // In dev, read from package.json.
  try {
    const pkgPath = path.resolve(__updater_dirname, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    _cachedAppVersion = pkg.version || electronVersion;
  } catch {
    _cachedAppVersion = electronVersion;
  }
  return _cachedAppVersion;
}
export function isUnpublishedUpdaterChannelError(error) {
  const message = String(error?.message ?? error ?? "");
  const statusCode = Number(error?.statusCode ?? error?.status ?? error?.response?.statusCode);
  const isNotFound = statusCode === 404 || /\b(?:HttpError:\s*)?404\b/i.test(message);
  const referencesChannelManifest = /\blatest(?:-[a-z0-9]+)?\.ya?ml\b/i.test(message);
  return isNotFound && referencesChannelManifest;
}

function normalizeElectronUpdaterChannel(value) {
  if (value === "alpha" && process.platform === "darwin") return "alpha";
  return "stable";
}

function electronUpdaterChannelPath(app) {
  return path.join(app.getPath("userData"), ELECTRON_UPDATER_CHANNEL_FILENAME);
}

async function readElectronUpdaterChannel(app) {
  try {
    const raw = await readFile(electronUpdaterChannelPath(app), "utf8");
    const parsed = JSON.parse(raw);
    return normalizeElectronUpdaterChannel(parsed?.channel);
  } catch {
    return "stable";
  }
}

async function writeElectronUpdaterChannel(app, channel) {
  const normalized = normalizeElectronUpdaterChannel(channel);
  const outputPath = electronUpdaterChannelPath(app);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify({ channel: normalized, writtenAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
  return normalized;
}

function normalizeStableTargetVersion(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/^v/i, "");
  return /^\d+\.\d+\.\d+$/.test(normalized) ? normalized : null;
}

function parseComparableVersion(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/^v/i, "");
  if (!normalized) return null;

  const [versionCore] = normalized.split("+", 1);
  if (!versionCore) return null;

  const [releasePart, prereleasePart = ""] = versionCore.split("-", 2);
  const release = releasePart.split(".").map((segment) => Number(segment));
  if (!release.length || release.some((segment) => !Number.isInteger(segment) || segment < 0)) {
    return null;
  }

  const prerelease = prereleasePart
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);

  return { release, prerelease };
}

function comparePrereleaseIdentifiers(left, right) {
  if (!left.length && !right.length) return 0;
  if (!left.length) return 1;
  if (!right.length) return -1;

  const count = Math.max(left.length, right.length);
  for (let index = 0; index < count; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;

    const leftNumeric = /^\d+$/.test(leftPart) ? Number(leftPart) : null;
    const rightNumeric = /^\d+$/.test(rightPart) ? Number(rightPart) : null;

    if (leftNumeric !== null && rightNumeric !== null) {
      if (leftNumeric !== rightNumeric) return leftNumeric < rightNumeric ? -1 : 1;
      continue;
    }

    if (leftNumeric !== null) return -1;
    if (rightNumeric !== null) return 1;

    const comparison = leftPart.localeCompare(rightPart);
    if (comparison !== 0) return comparison < 0 ? -1 : 1;
  }

  return 0;
}

function compareVersions(left, right) {
  const parsedLeft = parseComparableVersion(left);
  const parsedRight = parseComparableVersion(right);
  if (!parsedLeft || !parsedRight) return null;

  const count = Math.max(parsedLeft.release.length, parsedRight.release.length);
  for (let index = 0; index < count; index += 1) {
    const leftPart = parsedLeft.release[index] ?? 0;
    const rightPart = parsedRight.release[index] ?? 0;
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }

  return comparePrereleaseIdentifiers(parsedLeft.prerelease, parsedRight.prerelease);
}

function isVersionNewer(candidate, current) {
  const comparison = compareVersions(candidate, current);
  return comparison === null ? candidate !== current : comparison > 0;
}

export function targetedStableUpdaterFeed(
  currentVersion,
  targetVersion,
  platform = process.platform,
  arch = process.arch,
) {
  const normalizedTarget = normalizeStableTargetVersion(targetVersion);
  if (!normalizedTarget) {
    throw new Error("Target update version must use the stable x.y.z format.");
  }
  const comparison = compareVersions(normalizedTarget, currentVersion);
  if (comparison === null) {
    throw new Error("Installed version could not be validated for a targeted update.");
  }
  if (comparison <= 0) {
    throw new Error("Target update version must be newer than the installed version.");
  }
  return resolveDesktopUpdateFeed({
    platform,
    arch,
    channel: "stable",
    targetVersion: normalizedTarget,
  }).feedUrl;
}

function updaterChannelState(app, channel, targetVersion = null) {
  const normalized = normalizeElectronUpdaterChannel(channel);
  const currentVersion = resolveAppVersion(app);
  const resolvedFeed = resolveDesktopUpdateFeed({
    platform: process.platform,
    arch: process.arch,
    channel: normalized,
    targetVersion,
  });
  const feedUrl = targetVersion
    ? targetedStableUpdaterFeed(currentVersion, targetVersion)
    : resolvedFeed.feedUrl;
  return {
    channel: normalized,
    feedUrl,
    manifestUrl: `${feedUrl}/${resolvedFeed.manifestName}`,
    currentVersion,
  };
}

export function configureElectronUpdaterFeed(updater, state) {
  updater.allowPrerelease = state.channel === "alpha";
  // Stable updates are monotonic. Recovery from a bad release must use a
  // higher patch rather than silently moving an installed client backwards.
  updater.allowDowngrade = false;
  if (updater?.setFeedURL) {
    updater.setFeedURL({ provider: "generic", url: state.feedUrl });
  }
}

async function applyElectronUpdaterFeed(app, updater, targetVersion = null) {
  const channel = await readElectronUpdaterChannel(app);
  if (targetVersion && channel !== "stable") {
    throw new Error("Version-specific update feeds are supported only on the stable channel.");
  }
  const state = updaterChannelState(app, channel, targetVersion);
  configureElectronUpdaterFeed(updater, state);
  return state;
}

export function assertTargetUpdateManifestVersion(actualVersion, targetVersion) {
  if (targetVersion && compareVersions(actualVersion ?? "", targetVersion) !== 0) {
    throw new Error(`Target update manifest did not resolve to v${targetVersion}.`);
  }
}

function runDefaults(args) {
  return new Promise((resolve) => {
    execFile("/usr/bin/defaults", args, (error) => {
      // Best-effort: a failure here just means we fall back to Squirrel's
      // default move-based install. Never block the update on it.
      if (error) console.warn("[updater] defaults write failed", error?.message ?? error);
      resolve(undefined);
    });
  });
}

// Squirrel.Mac's `ShipIt` helper (which swaps the .app on macOS) reads its
// options from this NSUserDefaults domain.
const SHIP_IT_DEFAULTS_DOMAIN = "com.juggleai.jugglework.ShipIt";

// Squirrel.Mac defaults to moving the *entire* app bundle through a temp
// directory. On repeat installs that move can leave the staged bundle missing,
// producing:
//   "Failed to copy bundle … no such file or directory"
//   "Too many attempts to install, aborting update"
// and silently relaunching the OLD app (so the in-app version looks updated
// while the on-disk renderer stays stale). Enabling DirectContentsWrite makes
// ShipIt write file contents in place instead of moving whole bundles, which
// avoids the ENOENT abort.
async function enableSquirrelDirectContentsWrite() {
  if (process.platform !== "darwin") return;
  await runDefaults(["write", SHIP_IT_DEFAULTS_DOMAIN, "SquirrelMacEnableDirectContentsWrite", "-bool", "YES"]);
}

// Path of the ShipIt cache that, when stuck, keeps aborting future installs.
// Exported for tests.
export function staleUpdaterStatePaths(app) {
  if (process.platform !== "darwin") return [];
  const home = app.getPath("home");
  return [path.join(home, "Library", "Caches", SHIP_IT_DEFAULTS_DOMAIN)];
}

// Remove a previously-failed, half-applied update so the next attempt starts
// from a clean slate. A stuck `ShipIt` state (after "Too many attempts to
// install, aborting update") can otherwise keep aborting future installs.
async function cleanStaleUpdaterState(app) {
  for (const target of staleUpdaterStatePaths(app)) {
    try {
      await rm(target, { recursive: true, force: true });
    } catch (error) {
      console.warn("[updater] failed to clean stale state", target, error?.message ?? error);
    }
  }
}

// electron-updater wiring. Packaged-only; dev builds skip this so the
// updater doesn't try to probe a non-existent release channel.
export function preventPendingUpdaterInstall(updater) {
  if (updater) updater.autoInstallOnAppQuit = false;
}

export async function triggerUpdaterInstall(
  updater,
  onInstallAndRestart,
  onInstallAndRestartFailed,
  canStartInstall = () => true,
) {
  try {
    // electron-updater starts the Windows NSIS process before it asks Electron
    // to quit. Finish critical async cleanup first so packaged sidecars cannot
    // still hold files when the installer begins replacing the application.
    await onInstallAndRestart?.();
    if (!canStartInstall()) {
      throw new Error("The update was invalidated while preparing to install.");
    }
    updater.quitAndInstall(false, true);
  } catch (error) {
    onInstallAndRestartFailed?.();
    throw error;
  }
}

function validSha512(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(value)) return false;
  try {
    return Buffer.from(value, "base64").length === 64;
  } catch {
    return false;
  }
}

export function selectWindowsUpdateArtifact(updateInfo, arch = process.arch) {
  if (!WINDOWS_UPDATE_ARCHITECTURES.includes(arch)) {
    throw new Error(`Unsupported Windows update architecture: ${arch}`);
  }
  if (!updateInfo?.version || !Array.isArray(updateInfo.files)) {
    throw new Error("Windows update manifest inventory is missing.");
  }

  const inventory = new Map(WINDOWS_UPDATE_ARCHITECTURES.map((value) => [value, []]));
  for (const file of updateInfo.files) {
    if (typeof file?.url !== "string" || !validSha512(file.sha512)) {
      throw new Error("Windows update manifest contains an invalid EXE URL or SHA-512.");
    }
    let artifactUrl;
    try {
      artifactUrl = new URL(file.url);
    } catch {
      throw new Error(`Windows update artifact URL must be absolute: ${file.url}`);
    }
    if (artifactUrl.protocol !== "https:" || artifactUrl.origin !== WINDOWS_UPDATE_ORIGIN) {
      throw new Error(`Windows update artifact uses an unauthorized origin: ${file.url}`);
    }
    if (artifactUrl.search || artifactUrl.hash) {
      throw new Error(`Windows update artifact URL must be immutable: ${file.url}`);
    }
    const match = artifactUrl.pathname.match(
      /^\/jugglework\/releases\/v([^/]+)\/windows\/(x64|arm64)\/jugglework-win-(x64|arm64)-([^/]+)\.exe$/,
    );
    if (!match || match[1] !== updateInfo.version || match[2] !== match[3] || match[4] !== updateInfo.version) {
      throw new Error(`Windows update artifact is mutable, cross-architecture, or has the wrong version: ${file.url}`);
    }
    inventory.get(match[2]).push({ file, artifactUrl: artifactUrl.toString() });
  }

  for (const requiredArch of WINDOWS_UPDATE_ARCHITECTURES) {
    if (inventory.get(requiredArch).length !== 1) {
      throw new Error(`Windows update manifest must contain exactly one ${requiredArch} EXE.`);
    }
  }
  const selected = inventory.get(arch);
  if (selected.length !== 1) {
    throw new Error(`Windows update manifest does not uniquely select ${arch}.`);
  }
  return {
    arch,
    artifactUrl: selected[0].artifactUrl,
    sha512: selected[0].file.sha512,
    file: selected[0].file,
  };
}

export function registerUpdaterIpc({
  app,
  ipcMain,
  getMainWindow,
  onInstallAndRestart = undefined,
  onInstallAndRestartFailed = undefined,
  loadAutoUpdater = () => import("electron-updater"),
}) {
  let autoUpdaterPromise = null;
  let updaterOperation = Promise.resolve();
  let checkedCandidate = null;
  let downloadedCandidate = null;
  let activeDownloadUpdateId = null;
  let candidateGeneration = 0;
  let installIntentActive = false;
  const consumedUpdateIds = new Set();

  function invalidateCandidates() {
    candidateGeneration += 1;
    checkedCandidate = null;
    downloadedCandidate = null;
    activeDownloadUpdateId = null;
  }

  function failInstallIntent() {
    if (!installIntentActive) return;
    installIntentActive = false;
    onInstallAndRestartFailed?.();
  }

  function sendToRenderer(channel, data) {
    try {
      const win = typeof getMainWindow === "function" ? getMainWindow() : null;
      if (win?.webContents && !win.isDestroyed()) {
        win.webContents.send(channel, data);
      }
    } catch {
      // Window may be closed; swallow send failures.
    }
  }

  function ensureAutoUpdater() {
    if (!app.isPackaged) return Promise.resolve(null);
    if (!autoUpdaterPromise) {
      autoUpdaterPromise = (async () => {
        try {
          const mod = await loadAutoUpdater();
          const autoUpdaterInstance = mod.autoUpdater ?? mod.default?.autoUpdater ?? null;
          if (!autoUpdaterInstance) return null;
          autoUpdaterInstance.autoDownload = false;
          autoUpdaterInstance.autoInstallOnAppQuit = false;
          // Differential (blockmap) downloads reconstruct the update zip from the
          // installed app + a diff. On macOS that reconstructed bundle is what
          // feeds Squirrel's fragile move-based install, and is a common trigger
          // for the "Failed to copy bundle … no such file" abort. Download the
          // full zip instead — alpha builds are swapped wholesale anyway.
          autoUpdaterInstance.disableDifferentialDownload = true;
          // Make Squirrel.Mac write contents in place rather than moving whole
          // bundles (see enableSquirrelDirectContentsWrite for why).
          await enableSquirrelDirectContentsWrite();
          autoUpdaterInstance.on("error", (err) => {
            invalidateCandidates();
            failInstallIntent();
            if (isUnpublishedUpdaterChannelError(err)) {
              console.info("[updater] no release manifest is published for the selected channel");
            } else {
              console.warn("[updater] error", err);
            }
          });
          // Forward download progress to the renderer so the UI can show
          // incremental bytes instead of staying stuck at 0.
          autoUpdaterInstance.on("download-progress", (info) => {
            sendToRenderer("jugglework:updater:download-progress", {
              updateId: activeDownloadUpdateId,
              bytesPerSecond: info.bytesPerSecond ?? 0,
              percent: info.percent ?? 0,
              transferred: info.transferred ?? 0,
              total: info.total ?? 0,
              delta: info.delta ?? 0,
            });
          });
          await applyElectronUpdaterFeed(app, autoUpdaterInstance);
          autoUpdaterInstance.autoInstallOnAppQuit = false;
          return autoUpdaterInstance;
        } catch (error) {
          console.warn("[updater] electron-updater not available", error);
          return null;
        }
      })();
    }
    return autoUpdaterPromise;
  }

  function serializeUpdaterOperation(operation) {
    const result = updaterOperation.then(operation, operation);
    updaterOperation = result.then(() => undefined, () => undefined);
    return result;
  }

  function requestedUpdateId(value) {
    return typeof value === "string" && value.trim() ? value : null;
  }

  function missingUpdateIdResult() {
    return {
      ok: false,
      reason: "A non-empty updateId is required.",
      code: "missing-update-id",
    };
  }

  function staleCandidateResult() {
    return {
      ok: false,
      reason: "Update candidate is stale or no longer available.",
      code: "stale-update-candidate",
    };
  }

  ipcMain.handle("jugglework:updater:getChannel", async () => {
    const channel = await readElectronUpdaterChannel(app);
    return updaterChannelState(app, channel);
  });

  ipcMain.handle("jugglework:updater:setChannel", (_event, rawChannel) => serializeUpdaterOperation(async () => {
    const updater = await ensureAutoUpdater();
    const channel = await writeElectronUpdaterChannel(app, rawChannel);
    invalidateCandidates();
    if (updater) {
      // A channel change invalidates any previously downloaded update. This
      // also prevents an Alpha build from installing automatically on quit
      // after an organization policy moves the desktop back to Stable.
      preventPendingUpdaterInstall(updater);
      return applyElectronUpdaterFeed(app, updater);
    }
    return updaterChannelState(app, channel);
  }));

  ipcMain.handle("jugglework:updater:check", (_event, rawChannel, rawTargetVersion) => serializeUpdaterOperation(async () => {
    invalidateCandidates();
    const operationGeneration = candidateGeneration;
    const updater = await ensureAutoUpdater();
    if (rawChannel !== undefined) {
      await writeElectronUpdaterChannel(app, rawChannel);
    }
    let targetVersion = null;
    let channelState = null;
    try {
      targetVersion = rawTargetVersion === undefined
        ? null
        : normalizeStableTargetVersion(rawTargetVersion);
      if (rawTargetVersion !== undefined && !targetVersion) {
        throw new Error("Target update version must use the stable x.y.z format.");
      }
      channelState = updater
        ? await applyElectronUpdaterFeed(app, updater, targetVersion)
        : updaterChannelState(app, await readElectronUpdaterChannel(app), targetVersion);
      if (!updater) return { available: false, reason: "unavailable", ...channelState };

      const result = await updater.checkForUpdates();
      const info = result?.updateInfo ?? null;
      const currentVersion = resolveAppVersion(app);
      assertTargetUpdateManifestVersion(info?.version, targetVersion);
      const available = Boolean(info?.version && isVersionNewer(info.version, currentVersion));
      let windowsArtifact = null;
      if (available && process.platform === "win32") {
        windowsArtifact = selectWindowsUpdateArtifact(info, process.arch);
        // NsisUpdater selects the first EXE. Keep only the validated native
        // entry so electron-updater cannot choose the other architecture.
        info.files = [windowsArtifact.file];
        info.path = windowsArtifact.artifactUrl;
        info.sha512 = windowsArtifact.sha512;
      }
      if (candidateGeneration !== operationGeneration) {
        return { available: false, reason: "Update check was invalidated.", code: "stale-update-candidate" };
      }
      checkedCandidate = available
        ? {
            updateId: randomUUID(),
            version: info.version,
            targetVersion,
            channel: channelState.channel,
            feedUrl: channelState.feedUrl,
            manifestUrl: channelState.manifestUrl,
            arch: windowsArtifact?.arch ?? process.arch,
            artifactUrl: windowsArtifact?.artifactUrl ?? null,
            sha512: windowsArtifact?.sha512 ?? null,
          }
        : null;
      return {
        available,
        updateId: checkedCandidate?.updateId ?? null,
        candidate: checkedCandidate,
        currentVersion,
        latestVersion: targetVersion ?? info?.version ?? null,
        releaseDate: info?.releaseDate ?? null,
        releaseNotes: info?.releaseNotes ?? null,
        ...channelState,
      };
    } catch (error) {
      invalidateCandidates();
      const channel = await readElectronUpdaterChannel(app);
      let errorState = channelState;
      if (!errorState) {
        try {
          errorState = updaterChannelState(app, channel, targetVersion);
        } catch {
          errorState = updaterChannelState(app, channel);
        }
      }
      if (isUnpublishedUpdaterChannelError(error)) {
        return {
          available: false,
          updateId: null,
          candidate: null,
          latestVersion: resolveAppVersion(app),
          reason: `Update manifest was not found (404): ${errorState.manifestUrl}`,
          code: "update-manifest-not-found",
          statusCode: 404,
          ...errorState,
        };
      }
      return {
        available: false,
        updateId: null,
        candidate: null,
        reason: String(error?.message ?? error),
        ...errorState,
      };
    }
  }));

  ipcMain.handle("jugglework:updater:download", (_event, rawCandidate) => serializeUpdaterOperation(async () => {
    const updateId = requestedUpdateId(rawCandidate);
    if (!updateId) return missingUpdateIdResult();
    const updater = await ensureAutoUpdater();
    if (!updater) return { ok: false, reason: "unavailable" };
    const candidate = checkedCandidate;
    if (!candidate || updateId !== candidate.updateId) {
      return staleCandidateResult();
    }
    downloadedCandidate = null;
    const operationGeneration = candidateGeneration;
    try {
      configureElectronUpdaterFeed(updater, candidate);
      updater.autoInstallOnAppQuit = false;
      const currentVersion = resolveAppVersion(app);
      if (!isVersionNewer(candidate.version, currentVersion)) {
        invalidateCandidates();
        return { ok: false, reason: "No update available." };
      }
      // Clear any stuck ShipIt state from a prior aborted install so this
      // download applies cleanly on quit.
      await cleanStaleUpdaterState(app);
      activeDownloadUpdateId = candidate.updateId;
      await updater.downloadUpdate();
      if (candidateGeneration !== operationGeneration || checkedCandidate !== candidate) {
        return staleCandidateResult();
      }
      downloadedCandidate = candidate;
      return { ok: true, updateId: candidate.updateId, candidate };
    } catch (error) {
      invalidateCandidates();
      return { ok: false, reason: String(error?.message ?? error) };
    } finally {
      activeDownloadUpdateId = null;
      updater.autoInstallOnAppQuit = false;
    }
  }));

  ipcMain.handle("jugglework:updater:installAndRestart", (_event, rawCandidate) => serializeUpdaterOperation(async () => {
    const updateId = requestedUpdateId(rawCandidate);
    if (!updateId) return missingUpdateIdResult();
    if (consumedUpdateIds.has(updateId)) return staleCandidateResult();
    if (!downloadedCandidate) return { ok: false, reason: "update-not-downloaded" };
    if (updateId !== downloadedCandidate.updateId) {
      return staleCandidateResult();
    }
    const consumedCandidate = downloadedCandidate;
    const operationGeneration = candidateGeneration;
    downloadedCandidate = null;
    const updater = await ensureAutoUpdater();
    if (!updater) {
      downloadedCandidate = consumedCandidate;
      return { ok: false, reason: "unavailable" };
    }
    consumedUpdateIds.add(updateId);
    try {
      // Re-assert the in-place-write default right before the swap; the ShipIt
      // defaults domain may have been wiped when stale state was cleaned.
      await enableSquirrelDirectContentsWrite();
      // On macOS the native updater closes the window before Electron emits
      // `before-quit`. Preparation marks intent immediately before the native
      // call so close-to-tray cannot intercept the updater-owned window close.
      updater.autoInstallOnAppQuit = false;
      installIntentActive = true;
      await triggerUpdaterInstall(
        updater,
        onInstallAndRestart,
        failInstallIntent,
        () => installIntentActive
          && consumedUpdateIds.has(updateId)
          && candidateGeneration === operationGeneration,
      );
      if (!installIntentActive) {
        return { ok: false, reason: "The native updater failed to start." };
      }
      return { ok: true, updateId: consumedCandidate.updateId };
    } catch (error) {
      consumedUpdateIds.delete(updateId);
      // A concurrent updater error/new check changed the generation and made
      // this candidate unsafe to reuse. Restore only failures local to this
      // install attempt (cleanup or native installer launch).
      if (candidateGeneration === operationGeneration) {
        downloadedCandidate = consumedCandidate;
      }
      failInstallIntent();
      return { ok: false, reason: String(error?.message ?? error) };
    }
  }));

  return { ensureAutoUpdater };
}
