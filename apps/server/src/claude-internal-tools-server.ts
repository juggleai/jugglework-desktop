import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

import type { AgentRuntimeControlPlane } from "./agent-runtime-control-plane.js";
import type { AgentRuntimeRepository } from "./agent-runtime-persistence/repository.js";
import { canonicalizeToolPath } from "./agent-tool-policy/pre-tool-policy.js";
import { listSkills } from "./skills.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 32 * 1024;
const MAX_FILES = 100;
const MAX_SEARCH_MATCHES = 100;
const CREDENTIAL_TTL_MS = 60 * 60_000;
const CREDENTIAL_RENEWAL_WINDOW_MS = 5 * 60_000;
const EXCLUDED_DIRECTORIES = new Set([".git", "node_modules", ".next", "dist", "build", "coverage"]);

const envelopeSchema = z.object({
  schemaVersion: z.literal(1),
  workspaceId: z.string().trim().min(1).max(256),
  sessionId: z.string().trim().min(1).max(256),
  actor: z.literal("claude-worker"),
  tool: z.enum(["context", "query", "execute", "safe_glob", "search", "skill", "artifact"]),
  sideEffect: z.enum(["read", "write"]),
  expectedRevision: z.number().int().nonnegative(),
  args: z.record(z.string(), z.unknown()),
}).strict();

type Envelope = z.infer<typeof envelopeSchema>;

const toolSchemas = {
  context: z.object({ expectedRevision: z.number().int().nonnegative() }).strict(),
  query: z.object({
    expectedRevision: z.number().int().nonnegative(),
    id: z.enum(["session.snapshot", "skills.list", "artifacts.list"]),
    args: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
  execute: z.object({
    expectedRevision: z.number().int().nonnegative(),
    id: z.literal("session.abort"),
    args: z.object({ runId: z.string().trim().min(1).max(256) }).strict(),
  }).strict(),
  safe_glob: z.object({ expectedRevision: z.number().int().nonnegative(), pattern: z.string().trim().min(1).max(512), path: z.string().trim().max(4096).optional() }).strict(),
  search: z.object({ expectedRevision: z.number().int().nonnegative(), pattern: z.string().trim().min(1).max(1024), path: z.string().trim().max(4096).optional(), include: z.string().trim().max(512).optional() }).strict(),
  skill: z.object({ expectedRevision: z.number().int().nonnegative(), name: z.string().trim().min(1).max(128).optional() }).strict(),
  artifact: z.object({ expectedRevision: z.number().int().nonnegative(), operation: z.enum(["list", "read", "write"]), path: z.string().trim().min(1).max(4096).optional(), content: z.string().max(1_000_000).optional() }).strict(),
} as const;

const expectedSideEffect: Omit<Record<Envelope["tool"], Envelope["sideEffect"]>, "artifact"> = {
  context: "read",
  query: "read",
  execute: "write",
  safe_glob: "read",
  search: "read",
  skill: "read",
};

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function wildcard(pattern: string): RegExp {
  const normalized = pattern.replaceAll("\\", "/");
  return new RegExp(`^${normalized.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*")}$`);
}

async function safeRoot(workspace: WorkspaceInfo, requested?: string): Promise<string> {
  const workspaceRoot = await realpath(workspace.path);
  const candidate = await realpath(resolve(workspaceRoot, requested || "."));
  if (!isInside(workspaceRoot, candidate)) throw new Error("Path is outside the authorized workspace");
  return candidate;
}

async function walkFiles(root: string, limit = 2_000): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    if (files.length >= limit) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (files.length >= limit) return;
      if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  await walk(root);
  return files;
}

async function artifactRoot(workspace: WorkspaceInfo, create: boolean): Promise<string | null> {
  const workspaceRoot = await realpath(workspace.path);
  const lexicalRoot = resolve(workspaceRoot, ".opencode", "jugglework", "outbox");
  const canonical = await canonicalizeToolPath(lexicalRoot, workspaceRoot);
  if (!isInside(workspaceRoot, canonical.path)) throw new Error("Artifact root is outside the authorized workspace");
  if (!canonical.exists && !create) return null;
  if (create) await mkdir(canonical.path, { recursive: true });
  const root = await realpath(canonical.path);
  if (!isInside(workspaceRoot, root)) throw new Error("Artifact root is outside the authorized workspace");
  return root;
}

async function artifactPath(workspace: WorkspaceInfo, path: string, createParent: boolean): Promise<string> {
  const outbox = await artifactRoot(workspace, createParent);
  if (!outbox) throw new Error("Artifact is unavailable");
  const lexical = resolve(outbox, path);
  if (!isInside(outbox, lexical) || lexical === outbox) throw new Error("Artifact path is invalid");
  const canonical = await canonicalizeToolPath(lexical, outbox);
  if (!isInside(outbox, canonical.path)) throw new Error("Artifact path is outside the authorized outbox");
  if (!createParent) {
    if (!canonical.exists) throw new Error("Artifact is unavailable");
    return canonical.path;
  }
  await mkdir(dirname(canonical.path), { recursive: true });
  const parent = await realpath(dirname(canonical.path));
  if (!isInside(outbox, parent)) throw new Error("Artifact path is outside the authorized outbox");
  return join(parent, basename(canonical.path));
}

function bounded(value: unknown): unknown {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) <= MAX_RESULT_BYTES) return value;
  return { truncated: true, originalBytes: Buffer.byteLength(encoded), preview: Buffer.from(encoded).subarray(0, MAX_RESULT_BYTES - 128).toString("utf8") };
}

export type ClaudeInternalToolsServer = {
  url: string;
  credential: string;
  credentialExpiresAt: number;
  leaseCredential(): { credential: string; credentialExpiresAt: number };
  stop(): Promise<void>;
};

export async function startClaudeInternalToolsServer(input: {
  config: ServerConfig;
  repository: AgentRuntimeRepository;
  controlPlane: AgentRuntimeControlPlane;
  now?: () => number;
}): Promise<ClaudeInternalToolsServer> {
  const now = input.now ?? Date.now;
  const credentials: Array<{ credential: string; digest: Buffer; expiresAt: number }> = [];
  const issueCredential = () => {
    const currentTime = now();
    const current = credentials.at(-1);
    if (current && current.expiresAt - currentTime > CREDENTIAL_RENEWAL_WINDOW_MS) return current;
    const credential = randomBytes(32).toString("base64url");
    const issued = {
      credential,
      digest: createHash("sha256").update(credential).digest(),
      expiresAt: currentTime + CREDENTIAL_TTL_MS,
    };
    credentials.splice(0, credentials.length, ...credentials.filter(({ expiresAt }) => expiresAt > currentTime), issued);
    return issued;
  };
  const initialCredential = issueCredential();
  let server!: Server;

  const dispatch = async (envelope: Envelope): Promise<unknown> => {
    const workspace = input.config.workspaces.find(({ id }) => id === envelope.workspaceId);
    if (!workspace) throw new Error("Workspace is not authorized");
    const session = input.repository.getSession(envelope.sessionId);
    if (!session || session.workspaceId !== workspace.id || session.runtimeId !== "claude-agent") throw new Error("Session scope is not authorized");
    const args = toolSchemas[envelope.tool].parse(envelope.args) as Record<string, unknown>;
    const requiredEffect = envelope.tool === "artifact"
      ? args.operation === "write" ? "write" : "read"
      : expectedSideEffect[envelope.tool];
    if (envelope.sideEffect !== requiredEffect) throw new Error("Tool side effect does not match its authorization");
    if (args.expectedRevision !== envelope.expectedRevision) throw new Error("Expected revision does not match the tool payload");
    const revision = Math.floor(session.updatedAt);
    if (envelope.tool === "context") {
      if (envelope.expectedRevision !== 0 && envelope.expectedRevision !== revision) throw new Error("Context revision is stale");
      return { schemaVersion: 1, workspaceId: workspace.id, sessionId: session.id, actor: envelope.actor, revision, session: { id: session.id, runtimeId: session.runtimeId, title: session.title, status: session.status, cwd: session.canonicalCwd } };
    }
    if (envelope.expectedRevision !== revision) throw new Error("Context revision is stale");

    if (envelope.tool === "query") {
      const parsed = toolSchemas.query.parse(args);
      if (parsed.id === "session.snapshot") return input.controlPlane.snapshot(workspace.id, session.id, 100);
      if (parsed.id === "skills.list") return { items: await listSkills(workspace.path, false) };
      return artifactList(workspace);
    }
    if (envelope.tool === "execute") {
      if (input.config.readOnly) throw new Error("Server is read-only");
      const parsed = toolSchemas.execute.parse(args);
      return input.controlPlane.abortRun({ workspaceId: workspace.id, sessionId: session.id, runId: parsed.args.runId, abortCommandCorrelationId: null });
    }
    if (envelope.tool === "safe_glob") {
      const parsed = toolSchemas.safe_glob.parse(args);
      const root = await safeRoot(workspace, parsed.path);
      const matcher = wildcard(parsed.pattern);
      const files = (await walkFiles(root)).map((path) => relative(root, path).replaceAll("\\", "/")).filter((path) => matcher.test(path));
      return { root, files: files.slice(0, MAX_FILES).map((path) => resolve(root, path)), truncated: files.length > MAX_FILES };
    }
    if (envelope.tool === "search") {
      const parsed = toolSchemas.search.parse(args);
      const root = await safeRoot(workspace, parsed.path);
      const pattern = parsed.pattern.toLocaleLowerCase();
      const include = parsed.include ? wildcard(parsed.include) : null;
      const matches: Array<{ path: string; line: number; text: string }> = [];
      for (const path of await walkFiles(root)) {
        const relativePath = relative(root, path).replaceAll("\\", "/");
        if (include && !include.test(relativePath)) continue;
        const info = await stat(path);
        if (info.size > 1_000_000) continue;
        const content = await readFile(path, "utf8").catch(() => "");
        content.split(/\r?\n/).forEach((text, index) => {
          if (matches.length < MAX_SEARCH_MATCHES && text.toLocaleLowerCase().includes(pattern)) matches.push({ path, line: index + 1, text: text.slice(0, 2_000) });
        });
        if (matches.length >= MAX_SEARCH_MATCHES) break;
      }
      return { root, matches, truncated: matches.length >= MAX_SEARCH_MATCHES };
    }
    if (envelope.tool === "skill") {
      const parsed = toolSchemas.skill.parse(args);
      const skills = await listSkills(workspace.path, false);
      if (!parsed.name) return { items: skills.map(({ name, description, trigger }) => ({ name, description, trigger })) };
      const skill = skills.find(({ name }) => name === parsed.name);
      if (!skill) throw new Error("Skill was not found");
      return { name: skill.name, description: skill.description, content: (await readFile(skill.path, "utf8")).slice(0, 64 * 1024) };
    }

    const parsed = toolSchemas.artifact.parse(args);
    if (parsed.operation === "list") return artifactList(workspace);
    if (!parsed.path) throw new Error("Artifact path is required");
    const path = await artifactPath(workspace, parsed.path, parsed.operation === "write");
    if (parsed.operation === "read") {
      const info = await stat(path);
      if (!info.isFile() || info.size > 1_000_000) throw new Error("Artifact is unavailable or too large");
      return { path: parsed.path, content: await readFile(path, "utf8"), updatedAt: info.mtimeMs };
    }
    if (input.config.readOnly || parsed.content === undefined) throw new Error("Artifact write is not authorized");
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${randomBytes(8).toString("hex")}`;
    await writeFile(temporary, parsed.content, "utf8");
    await rename(temporary, path);
    return { path: parsed.path, bytes: Buffer.byteLength(parsed.content) };
  };

  server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST" || request.url !== "/v1/internal-tools/call" || request.socket.remoteAddress?.replace("::ffff:", "") !== "127.0.0.1") throw new Error("Internal tool endpoint is unavailable");
      const supplied = request.headers["x-jugglework-claude-tool-credential"];
      const suppliedDigest = createHash("sha256").update(typeof supplied === "string" ? supplied : "invalid").digest();
      const currentTime = now();
      if (!credentials.some(({ digest, expiresAt }) => expiresAt > currentTime && timingSafeEqual(digest, suppliedDigest))) {
        throw new Error("Internal tool credential is invalid");
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > MAX_BODY_BYTES) throw new Error("Internal tool request is too large");
        chunks.push(buffer);
      }
      const envelope = envelopeSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const result = bounded(await dispatch(envelope));
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: true, result }));
    })().catch((error) => {
      response.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: false, error: { code: "reauthorization_failed", message: error instanceof Error ? error.message : "Internal tool failed" } }));
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Internal tool server did not bind");
  let stopPromise: Promise<void> | null = null;
  return {
    url: `http://127.0.0.1:${address.port}/v1/internal-tools/call`,
    credential: initialCredential.credential,
    credentialExpiresAt: initialCredential.expiresAt,
    leaseCredential: () => {
      const lease = issueCredential();
      return { credential: lease.credential, credentialExpiresAt: lease.expiresAt };
    },
    stop: () => {
      stopPromise ??= new Promise<void>((resolveStop, reject) => server.close((error) => error ? reject(error) : resolveStop()));
      return stopPromise;
    },
  };
}

async function artifactList(workspace: WorkspaceInfo): Promise<unknown> {
  const root = await artifactRoot(workspace, false);
  if (!root) return { items: [], truncated: false };
  const files = await walkFiles(root, MAX_FILES + 1);
  const items = await Promise.all(files.slice(0, MAX_FILES).map(async (path) => {
    const info = await stat(path);
    return { path: relative(root, path).replaceAll("\\", "/"), size: info.size, updatedAt: info.mtimeMs };
  }));
  return { items, truncated: files.length > MAX_FILES };
}
