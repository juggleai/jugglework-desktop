import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const INITIALIZE_REQUEST = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "jugglework-packaged-smoke", version: "1.0.0" },
  },
};

export async function verifyJuggleWorkUiMcp({
  runtime,
  entry,
  environment = {},
  timeoutMs = 10_000,
} = {}) {
  if (!runtime || !entry) throw new Error("UI control MCP verification requires runtime and entry paths.");

  return await new Promise((resolve, reject) => {
    const child = spawn(runtime, [entry], {
      env: { ...process.env, ...environment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outcome = null;
    let terminationTimer = null;
    let finalizationTimer = null;
    let settled = false;
    const detachChild = () => {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    };
    const terminateProcess = () => {
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        killer.on("error", () => detachChild());
        killer.on("close", (code) => {
          if (code !== 0 && child.exitCode === null && child.signalCode === null) detachChild();
        });
        killer.unref();
        return;
      }
      child.kill();
    };

    const terminate = (error, value) => {
      if (outcome) return;
      outcome = { error, value };
      clearTimeout(timer);
      child.stdin.destroy();
      if (error && child.exitCode === null && child.signalCode === null) terminateProcess();
      terminationTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          outcome = { error: error ?? new Error("UI control MCP did not terminate cleanly after initialize."), value: null };
          if (process.platform === "win32") terminateProcess();
          else child.kill("SIGKILL");
        }
      }, 2_000);
      terminationTimer.unref?.();
      finalizationTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        detachChild();
        reject(outcome?.error ?? new Error("UI control MCP process could not be terminated."));
      }, 4_000);
    };

    const timer = setTimeout(() => {
      terminate(new Error(`UI control MCP initialize timed out after ${timeoutMs}ms${stderr ? `: ${stderr.trim()}` : ""}`));
    }, timeoutMs);

    child.on("error", (error) => {
      if (!outcome) {
        clearTimeout(timer);
        outcome = { error, value: null };
        settled = true;
        reject(error);
      }
    });
    child.stdin.on("error", (error) => {
      if (error?.code !== "EPIPE") terminate(error);
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      for (;;) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) break;
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message?.id !== INITIALIZE_REQUEST.id) continue;
        if (message.error) {
          terminate(new Error(`UI control MCP initialize failed: ${JSON.stringify(message.error)}`));
          return;
        }
        const serverInfo = message?.result?.serverInfo;
        if (serverInfo?.name !== "jugglework-ui") {
          terminate(new Error(`Unexpected UI control MCP server identity: ${serverInfo?.name ?? "<missing>"}`));
          return;
        }
        terminate(null, { protocolVersion: message.result.protocolVersion, serverInfo });
        return;
      }
    });
    child.on("close", (code, signal) => {
      if (terminationTimer) clearTimeout(terminationTimer);
      if (finalizationTimer) clearTimeout(finalizationTimer);
      if (settled) return;
      settled = true;
      if (!outcome) {
        clearTimeout(timer);
        reject(new Error(`UI control MCP exited before initialize (code=${code}, signal=${signal})${stderr ? `: ${stderr.trim()}` : ""}`));
        return;
      }
      if (outcome.error) reject(outcome.error);
      else resolve(outcome.value);
    });

    child.stdin.end(`${JSON.stringify(INITIALIZE_REQUEST)}\n`);
  });
}

function readArg(name) {
  const inline = process.argv.find((entry) => entry.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() ?? "" : "";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const runtime = readArg("--runtime") || process.execPath;
    const entry = readArg("--entry") || process.argv[2];
    const result = await verifyJuggleWorkUiMcp({
      runtime,
      entry,
      environment: runtime === process.execPath ? {} : { ELECTRON_RUN_AS_NODE: "1" },
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
