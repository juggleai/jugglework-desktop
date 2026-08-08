import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDirectServerHeadlessLaunch } from "./direct-server-headless.js";

const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("missing test port"));
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitFor<T>(operation: () => Promise<T | null>, message: string): Promise<T> {
  const deadline = Date.now() + 15_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result !== null) return result;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(50);
  }
  throw new Error(`${message}${lastError ? `: ${String(lastError)}` : ""}`);
}

function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("direct Server headless serves APIs and shuts down managed OpenCode without an orphan", async () => {
  const repoRoot = resolve(import.meta.dir, "..");
  const root = await mkdtemp(join(tmpdir(), "jugglework-direct-headless-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const dataDir = join(root, "data");
  const fakeBin = join(root, "opencode");
  const pidFile = join(root, "opencode.pid");
  const modelsFile = join(root, "models-url.txt");
  await mkdir(workspace, { recursive: true });
  await writeFile(fakeBin, `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const valueAfter = (name) => args[args.indexOf(name) + 1];
const hostname = valueAfter("--hostname") || "127.0.0.1";
const port = Number(valueAfter("--port"));
const session = { id: "ses_smoke", title: "Direct headless", slug: "direct-headless", directory: process.cwd(), time: { created: 100, updated: 100 } };
writeFileSync(process.env.FAKE_OPENCODE_PID_FILE, String(process.pid));
writeFileSync(process.env.FAKE_OPENCODE_MODELS_FILE, process.env.OPENCODE_MODELS_URL || "");
const server = Bun.serve({
  hostname,
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/session" && request.method === "POST") return Response.json(session);
    if (url.pathname === "/session" && request.method === "GET") return Response.json([session]);
    if (url.pathname === "/session/ses_smoke") return Response.json(session);
    if (url.pathname === "/event") return new Response("data: {\\"type\\":\\"server.connected\\"}\\n\\n", { headers: { "content-type": "text/event-stream" } });
    return Response.json({ code: "not_found" }, { status: 404 });
  },
});
console.log(\`opencode server listening on http://\${hostname}:\${server.port}\`);
const stop = () => { server.stop(true); process.exit(0); };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
`, "utf8");
  await chmod(fakeBin, 0o755);

  const port = await freePort();
  const token = "direct-client-token";
  const modelsUrl = "https://work.juggle.im/jwork/models";
  const launch = await createDirectServerHeadlessLaunch({
    workspace,
    host: "127.0.0.1",
    port,
    token,
    hostToken: "direct-host-token",
    approval: "auto",
    opencodeBin: fakeBin,
  }, {
    ...process.env,
    HOME: root,
    JUGGLEWORK_DATA_DIR: dataDir,
    JUGGLEWORK_SERVER_CONFIG: join(root, "server.json"),
    OPENCODE_MODELS_URL: modelsUrl,
    FAKE_OPENCODE_PID_FILE: pidFile,
    FAKE_OPENCODE_MODELS_FILE: modelsFile,
  });
  expect(launch.env.JUGGLEWORK_MANAGE_OPENCODE).toBe("1");
  expect(launch.env.JUGGLEWORK_OPENCODE_BIN).toBe(fakeBin);

  let output = "";
  const child = spawn("bun", [join(repoRoot, "apps/server/src/cli.ts"), ...launch.args], {
    cwd: repoRoot,
    env: launch.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  child.stdout?.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk) => { output += chunk.toString(); });

  const base = `http://127.0.0.1:${port}`;
  const auth = { Authorization: `Bearer ${token}` };
  await waitFor(async () => {
    const response = await fetch(`${base}/health`);
    return response.ok ? response : null;
  }, `Server did not become healthy\n${output}`);

  const workspaces = await waitFor(async () => {
    const response = await fetch(`${base}/workspaces`, { headers: auth });
    if (!response.ok) return null;
    const body = await response.json() as {
      items: Array<{ id: string; path: string; opencode?: { baseUrl?: string } }>;
    };
    return body.items[0]?.opencode?.baseUrl ? body : null;
  }, `managed OpenCode was not attached to the workspace\n${output}`);
  expect(workspaces.items).toHaveLength(1);
  expect(workspaces.items[0]?.path).toBe(workspace);
  const workspaceId = workspaces.items[0]?.id;
  if (!workspaceId) throw new Error("headless workspace id missing");

  const sessionResponse = await fetch(`${base}/workspace/${workspaceId}/sessions`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Direct headless" }),
  });
  const sessionBody = await sessionResponse.json();
  expect(sessionResponse.status, `${JSON.stringify(sessionBody)}\n${output}`).toBe(201);
  expect(sessionBody).toMatchObject({ item: { id: "ses_smoke" } });

  const sseResponse = await fetch(`${base}/w/${workspaceId}/opencode/event`, { headers: auth });
  expect(sseResponse.status).toBe(200);
  expect(sseResponse.headers.get("content-type")).toContain("text/event-stream");
  expect(await sseResponse.text()).toContain("server.connected");

  const opencodePid = await waitFor(async () => {
    const value = Number((await readFile(pidFile, "utf8")).trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  }, "managed OpenCode pid was not recorded");
  expect(await readFile(modelsFile, "utf8")).toBe(modelsUrl);
  expect(isProcessAlive(opencodePid)).toBe(true);

  child.kill("SIGTERM");
  const exit = await Promise.race([
    waitForExit(child),
    Bun.sleep(7_000).then(() => { throw new Error(`Server shutdown timed out\n${output}`); }),
  ]);
  expect(exit).toEqual({ code: 0, signal: null });
  await waitFor(async () => isProcessAlive(opencodePid) ? null : true, "managed OpenCode was orphaned");
});
