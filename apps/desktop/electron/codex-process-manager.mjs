import { spawn } from "node:child_process";
import { stat, realpath } from "node:fs/promises";
import path from "node:path";

import { createCodexAppServerClient } from "./codex-app-server-client.mjs";
import { createCodexCredentialBroker } from "./codex-credential-broker.mjs";
import { writeCodexRuntimeConfig } from "./codex-runtime-config.mjs";

export class CodexProcessManagerError extends Error {
  constructor(code) {
    super("The Codex workspace runtime failed.");
    this.name = "CodexProcessManagerError";
    this.code = code;
  }
}

function requiredText(value, code) {
  const text = String(value ?? "").trim();
  if (!text) throw new CodexProcessManagerError(code);
  return text;
}

function targetTriple(platform = process.platform, arch = process.arch) {
  if (platform === "darwin") return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  if (platform === "win32") return arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  if (platform === "linux") return arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
  throw new CodexProcessManagerError("unsupported_platform");
}

/** @param {{ desktopRoot?: string, resourcesPath?: string, packaged?: boolean, platform?: NodeJS.Platform, arch?: NodeJS.Architecture }} [input] */
export function resolveBundledCodexCommand({ desktopRoot, resourcesPath, packaged = false, platform, arch } = {}) {
  const triple = targetTriple(platform, arch);
  const filename = `codex-${triple}${(platform ?? process.platform) === "win32" ? ".exe" : ""}`;
  return path.join(packaged ? requiredText(resourcesPath, "resources_path_required") : requiredText(desktopRoot, "desktop_root_required"), packaged ? "sidecars" : "resources/sidecars", filename);
}

function processTreeTerminator(platform = process.platform) {
  return (child, signal = "SIGTERM") => {
    if (!child || !Number.isInteger(child.pid)) return;
    if (platform === "win32") {
      spawn("taskkill.exe", ["/pid", String(child.pid), "/t", signal === "SIGKILL" ? "/f" : ""].filter(Boolean), {
        stdio: "ignore", windowsHide: true, shell: false,
      }).unref();
      return;
    }
    try { process.kill(-child.pid, signal); } catch {
      try { child.kill(signal); } catch { /* already exited */ }
    }
  };
}

/** Main-process owner for one lazily-created Codex App Server per workspace. */
export function createCodexProcessManager(options = {}) {
  if (!options.tokenProvider?.getToken || !options.tokenProvider?.invalidate) {
    throw new TypeError("Codex token provider is required.");
  }
  const userDataPath = path.resolve(requiredText(options.userDataPath, "user_data_required"));
  const command = options.command ?? resolveBundledCodexCommand(options);
  const createBroker = options.createBroker ?? ((input) => createCodexCredentialBroker(input));
  const writeConfig = options.writeConfig ?? writeCodexRuntimeConfig;
  const createClient = options.createClient ?? ((input) => createCodexAppServerClient(input));
  const terminateProcess = options.terminateProcess ?? processTreeTerminator(options.platform);
  const records = new Map();
  const starts = new Map();
  let disposed = false;

  function publicStatus(record) {
    if (!record) return null;
    return Object.freeze({
      workspaceId: record.workspaceId,
      organizationId: record.organizationId,
      state: record.state,
      running: record.state === "ready" && record.client?.snapshot().running === true,
      model: record.model,
      failureCode: record.failureCode ?? null,
    });
  }

  async function stopRecord(record, finalState = "stopped") {
    if (!record || record.stopping) return record?.stopping;
    record.state = "stopping";
    record.stopping = (async () => {
      await record.client?.close().catch(() => undefined);
      await record.broker?.dispose().catch(() => undefined);
      record.state = finalState;
      if (records.get(record.workspaceId) === record && finalState === "stopped") records.delete(record.workspaceId);
    })();
    return record.stopping;
  }

  async function startWorkspace(rawInput) {
    if (disposed) throw new CodexProcessManagerError("disposed");
    const workspaceId = requiredText(rawInput?.workspaceId, "workspace_id_required");
    if (rawInput?.workspaceType && rawInput.workspaceType !== "local") throw new CodexProcessManagerError("local_workspace_required");
    const existingStart = starts.get(workspaceId);
    if (existingStart) return existingStart;
    const pending = (async () => {
      const organizationId = requiredText(rawInput?.organizationId, "organization_id_required");
      const deviceId = requiredText(rawInput?.deviceId, "device_id_required");
      const providerId = requiredText(rawInput?.providerId, "provider_id_required");
      const model = requiredText(rawInput?.model, "model_required");
      const cwd = await realpath(path.resolve(requiredText(rawInput?.cwd, "cwd_required"))).catch(() => {
        throw new CodexProcessManagerError("workspace_unavailable");
      });
      if (!(await stat(cwd)).isDirectory()) throw new CodexProcessManagerError("workspace_unavailable");
      const current = records.get(workspaceId);
      if (current?.state === "ready" && current.organizationId === organizationId && current.cwd === cwd &&
          current.providerId === providerId && current.model === model && current.client.snapshot().running) {
        return current.handle;
      }
      if (current) await stopRecord(current);

      const broker = createBroker({ tokenProvider: options.tokenProvider, fetcher: options.fetcher });
      let client = null;
      const record = {
        workspaceId, organizationId, deviceId, providerId, model, cwd,
        state: "starting", failureCode: null, broker, client, handle: null, stopping: null,
      };
      records.set(workspaceId, record);
      try {
        const brokerAccess = await broker.start({ organizationId, deviceId, providerId });
        const runtime = await writeConfig({
          userDataPath, organizationId, workspaceId,
          brokerBaseUrl: brokerAccess.baseUrl,
          localSecret: brokerAccess.localSecret,
          model,
          reasoningEffort: rawInput?.reasoningEffort,
          workspaceRoot: cwd,
          bundledSkillsDir: options.bundledSkillsDir,
        });
        record.capabilities = runtime.capabilities;
        client = createClient({
          command,
          args: ["app-server", "--stdio"],
          cwd,
          env: Object.fromEntries(Object.entries({ ...process.env, ...runtime.env }).filter(([key]) => key !== "CODEX_API_KEY" && key !== "OPENAI_API_KEY")),
          detached: options.platform !== "win32",
          terminateProcess,
          onExit: () => {
            if (record.state === "stopping" || record.state === "stopped") return;
            record.state = "crashed";
            record.failureCode = "runtime_exited";
            void broker.dispose();
          },
        });
        record.client = client;
        const initialized = await client.initialize({
          clientInfo: options.clientInfo,
          capabilities: { experimentalApi: true },
        });
        if (initialized?.codexHome && path.resolve(String(initialized.codexHome)) !== path.resolve(runtime.codexHome)) {
          throw new CodexProcessManagerError("codex_home_mismatch");
        }
        record.state = "ready";
        record.handle = Object.freeze({ workspaceId, organizationId, model, appServer: client });
        return record.handle;
      } catch (error) {
        record.state = "failed";
        record.failureCode = error?.code ?? "runtime_start_failed";
        await client?.close().catch(() => undefined);
        await broker.dispose().catch(() => undefined);
        throw error instanceof CodexProcessManagerError ? error : new CodexProcessManagerError(record.failureCode);
      }
    })().finally(() => starts.delete(workspaceId));
    starts.set(workspaceId, pending);
    return pending;
  }

  async function stopWorkspace(workspaceId) {
    const key = requiredText(workspaceId, "workspace_id_required");
    await starts.get(key)?.catch(() => undefined);
    await stopRecord(records.get(key));
  }

  async function stopOrganization(organizationId) {
    const key = requiredText(organizationId, "organization_id_required");
    options.tokenProvider.invalidate({ organizationId: key });
    await Promise.all([...records.values()].filter((record) => record.organizationId === key).map((record) => stopRecord(record)));
  }

  function status(workspaceId) {
    if (workspaceId !== undefined) return publicStatus(records.get(String(workspaceId)));
    return Object.freeze([...records.values()].map(publicStatus));
  }

  function capabilitySnapshot(workspaceId) {
    const record = records.get(requiredText(workspaceId, "workspace_id_required"));
    if (!record?.capabilities) return null;
    return structuredClone(record.capabilities);
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    options.tokenProvider.invalidate();
    await Promise.all([...starts.values()].map((pending) => pending.catch(() => undefined)));
    await Promise.all([...records.values()].map((record) => stopRecord(record)));
  }

  return Object.freeze({ startWorkspace, stopWorkspace, stopOrganization, status, capabilitySnapshot, dispose });
}
