import { lookup } from "node:dns/promises";
import { lstat, realpath } from "node:fs/promises";
import { isIP } from "node:net";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { TokenScope } from "../types.js";

const DEFAULT_MAX_INPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_INPUT_DEPTH = 12;
const DEFAULT_MAX_INPUT_NODES = 2_000;
const DEFAULT_MAX_STRING_BYTES = 32 * 1024;
const DEFAULT_MAX_COMMAND_BYTES = 16 * 1024;

const FORBIDDEN_INPUT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

const DEFAULT_COMMAND_DENY_PATTERNS: readonly CommandPattern[] = [
  { id: "command_multiline", pattern: /[\r\n\0]/ },
  { id: "privilege_escalation", pattern: /(?:^|[^\w-])(?:sudo|doas|pkexec|su)(?:\s|$)/i },
  { id: "permission_bypass", pattern: /--(?:no-sandbox|privileged|dangerously-skip-permissions|allow-dangerous[^\s]*)\b|dangerouslyDisableSandbox/i },
  { id: "host_namespace", pattern: /--(?:pid|network|ipc|uts)=host\b|(?:^|\s)-v\s*\/(?:\s*):/i },
  { id: "device_write", pattern: /(?:^|[;&|()]\s*)(?:mkfs(?:\.[\w-]+)?|fdisk|parted)\b|\bdd\b[^\r\n]*\bof=\/dev\//i },
  { id: "root_delete", pattern: /\brm\b[^\r\n]*(?:--no-preserve-root|(?:^|\s)\/(?:\s|$)|(?:^|\s)~\/?(?:\s|$))/i },
  { id: "host_control", pattern: /(?:^|[^\w-])(?:shutdown|reboot|halt|launchctl|systemctl)\b/i },
  { id: "reverse_shell", pattern: /\/dev\/(?:tcp|udp)\/|(?:^|[^\w-])(?:nc|ncat|netcat|socat)\b/i },
  { id: "download_execute", pattern: /\b(?:curl|wget)\b[^\r\n]*(?:\||>\s*\/)/i },
  {
    id: "network_command_requires_controlled_tool",
    pattern: /(?:^|[^\w-])(?:curl|wget|nc|ncat|netcat|socat|ssh|scp|sftp|ftp|telnet)\b|\bgit\s+(?:clone|fetch|pull|push|ls-remote)\b/i,
  },
  { id: "fork_bomb", pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/ },
];

const SENSITIVE_DIRECTORY_SEQUENCES: readonly (readonly string[])[] = [
  [".ssh"],
  [".gnupg"],
  [".aws"],
  [".azure"],
  [".kube"],
  [".docker"],
  [".config", "gcloud"],
  [".local", "share", "keyrings"],
  ["library", "keychains"],
];

const SENSITIVE_FILE_NAMES = new Set([
  ".netrc",
  "_netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  "credentials.json",
  "application_default_credentials.json",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "known_hosts",
]);

const SENSITIVE_FILE_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx"]);

export type ToolEffect = "read" | "write" | "execute" | "network";
export type ToolPathAccess = "read" | "write" | "delete";

export interface ToolActorScope {
  id: string;
  scope: TokenScope;
  workspaceId: string;
  sessionId?: string;
}

export interface ToolPathBinding {
  inputKey: string;
  access: ToolPathAccess;
  allowMissing?: boolean;
}

export interface ToolCommandBinding {
  inputKey: string;
  sandboxed: boolean;
}

export interface ToolNetworkBinding {
  inputKey: string;
}

export interface CanonicalToolOperation {
  effect: ToolEffect;
  /** Only these top-level keys survive policy evaluation. */
  allowedInputKeys: readonly string[];
  paths?: readonly ToolPathBinding[];
  command?: ToolCommandBinding;
  networkDestinations?: readonly ToolNetworkBinding[];
  minimumActorScope?: TokenScope;
}

export interface PreToolPolicyRequest {
  runtimeId: string;
  toolName: string;
  workspaceId: string;
  sessionId: string;
  workspaceRoot: string;
  actor: ToolActorScope;
  input: unknown;
  operation: CanonicalToolOperation;
}

export interface CommandPattern {
  id: string;
  pattern: RegExp;
}

export interface NetworkDestinationRule {
  /** Exact hostname or a subdomain-only wildcard such as `*.example.com`. */
  hostname: string;
  protocols?: readonly ("http:" | "https:")[];
  ports?: readonly number[];
}

export interface PreToolPolicyOptions {
  authorizedRoots: readonly string[];
  sensitivePaths?: readonly string[];
  networkDestinations?: readonly NetworkDestinationRule[];
  additionalCommandDenyPatterns?: readonly CommandPattern[];
  resolveNetworkAddresses?: (hostname: string) => Promise<readonly string[]>;
  maxInputBytes?: number;
  maxInputDepth?: number;
  maxInputNodes?: number;
  maxStringBytes?: number;
  maxCommandBytes?: number;
}

export type PreToolPolicyDenialCode =
  | "invalid_policy_request"
  | "invalid_tool_input"
  | "tool_input_too_large"
  | "actor_scope_denied"
  | "actor_context_mismatch"
  | "authorized_root_unavailable"
  | "workspace_root_unauthorized"
  | "path_unavailable"
  | "path_outside_authorized_roots"
  | "sensitive_path_denied"
  | "command_requires_sandbox"
  | "command_denied"
  | "network_destination_denied"
  | "network_resolution_failed"
  | "network_address_denied"
  | "policy_evaluation_failed";

export type PreToolPolicyDecision =
  | {
    decision: "allow";
    input: Record<string, unknown>;
    modified: boolean;
    basis: string[];
  }
  | {
    decision: "deny";
    code: PreToolPolicyDenialCode;
    reason: string;
    basis: string[];
  };

type CanonicalPath = { path: string; exists: boolean };

class PolicyDenial extends Error {
  constructor(
    readonly code: PreToolPolicyDenialCode,
    message: string,
    readonly basis: string[] = [code],
  ) {
    super(message);
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return resolved;
}

function isFilesystemMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR");
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

/**
 * Resolve every existing path component. Missing leaves are appended to the
 * nearest real ancestor, so a symlink in any existing parent cannot hide an
 * authorization escape.
 */
export async function canonicalizeToolPath(rawPath: string, basePath: string): Promise<CanonicalPath> {
  if (!rawPath || rawPath.includes("\0")) {
    throw new PolicyDenial("invalid_tool_input", "Tool path must be a non-empty string without NUL bytes");
  }
  const lexicalPath = isAbsolute(rawPath) ? resolve(rawPath) : resolve(basePath, rawPath);
  let cursor = lexicalPath;
  const missingSegments: string[] = [];

  while (true) {
    try {
      const resolvedPath = await realpath(cursor);
      return {
        path: missingSegments.length ? resolve(resolvedPath, ...missingSegments.reverse()) : resolvedPath,
        exists: missingSegments.length === 0,
      };
    } catch (error) {
      try {
        await lstat(cursor);
        throw new PolicyDenial("path_unavailable", "Tool path could not be resolved safely");
      } catch (metadataError) {
        if (!isFilesystemMissing(metadataError)) {
          if (metadataError instanceof PolicyDenial) throw metadataError;
          throw new PolicyDenial("path_unavailable", "Tool path metadata could not be inspected safely");
        }
      }

      const parent = dirname(cursor);
      if (parent === cursor) {
        throw new PolicyDenial("path_unavailable", "Tool path has no resolvable ancestor");
      }
      missingSegments.push(basename(cursor));
      cursor = parent;
    }
  }
}

function sanitizeJsonValue(
  value: unknown,
  limits: { maxDepth: number; maxNodes: number; maxStringBytes: number },
  seen: Set<object>,
  depth = 0,
  counter = { value: 0 },
): unknown {
  counter.value += 1;
  if (counter.value > limits.maxNodes || depth > limits.maxDepth) {
    throw new PolicyDenial("tool_input_too_large", "Tool input exceeds structural limits");
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string" && byteLength(value) > limits.maxStringBytes) {
      throw new PolicyDenial("tool_input_too_large", "Tool input contains an oversized string");
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new PolicyDenial("invalid_tool_input", "Tool input numbers must be finite");
    return value;
  }
  if (typeof value !== "object") {
    throw new PolicyDenial("invalid_tool_input", "Tool input must contain only JSON values");
  }
  if (seen.has(value)) throw new PolicyDenial("invalid_tool_input", "Tool input must not contain cycles");
  seen.add(value);
  try {
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new PolicyDenial("invalid_tool_input", "Tool input must not contain symbol keys");
    }
    if (Array.isArray(value)) {
      return value.map((item) => sanitizeJsonValue(item, limits, seen, depth + 1, counter));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new PolicyDenial("invalid_tool_input", "Tool input must contain only plain objects");
    }

    const output: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(value)) {
      if (FORBIDDEN_INPUT_KEYS.has(key)) {
        throw new PolicyDenial("invalid_tool_input", "Tool input contains a forbidden key");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        throw new PolicyDenial("invalid_tool_input", "Tool input must not contain accessors");
      }
      output[key] = sanitizeJsonValue(descriptor.value, limits, seen, depth + 1, counter);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function normalizeHostname(value: string): string {
  return value.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function ipv4Number(address: string): number | null {
  if (isIP(address) !== 4) return null;
  const parts = address.split(".").map(Number);
  return (((parts[0]! * 256 + parts[1]!) * 256 + parts[2]!) * 256 + parts[3]!) >>> 0;
}

function isPublicIpv4(address: string): boolean {
  const value = ipv4Number(address);
  if (value === null) return false;
  const inRange = (start: number, end: number) => value >= start && value <= end;
  return !(
    inRange(0x00000000, 0x00ffffff) ||
    inRange(0x0a000000, 0x0affffff) ||
    inRange(0x64400000, 0x647fffff) ||
    inRange(0x7f000000, 0x7fffffff) ||
    inRange(0xa9fe0000, 0xa9feffff) ||
    inRange(0xac100000, 0xac1fffff) ||
    inRange(0xc0000000, 0xc00000ff) ||
    inRange(0xc0000200, 0xc00002ff) ||
    inRange(0xc0a80000, 0xc0a8ffff) ||
    inRange(0xc6120000, 0xc613ffff) ||
    inRange(0xc6336400, 0xc63364ff) ||
    inRange(0xcb007100, 0xcb0071ff) ||
    value >= 0xe0000000
  );
}

function isPublicIpAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  if (isIP(normalized) === 4) return isPublicIpv4(normalized);
  if (isIP(normalized) !== 6) return false;
  if (normalized.startsWith("::ffff:")) {
    return isPublicIpv4(normalized.slice("::ffff:".length));
  }
  if (normalized === "::" || normalized === "::1" || normalized.startsWith("2001:db8:")) return false;
  const firstGroup = Number.parseInt(normalized.split(":", 1)[0] ?? "", 16);
  return Number.isFinite(firstGroup) && firstGroup >= 0x2000 && firstGroup <= 0x3fff;
}

function hostnameMatches(ruleHostname: string, hostname: string): boolean {
  const normalizedRule = normalizeHostname(ruleHostname);
  if (normalizedRule.startsWith("*.")) {
    const suffix = normalizedRule.slice(2);
    return hostname.endsWith(`.${suffix}`) && hostname !== suffix;
  }
  return hostname === normalizedRule;
}

function isSensitivePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  const segments = normalized.split("/").filter(Boolean);
  for (const sequence of SENSITIVE_DIRECTORY_SEQUENCES) {
    for (let index = 0; index <= segments.length - sequence.length; index += 1) {
      if (sequence.every((segment, offset) => segments[index + offset] === segment)) return true;
    }
  }
  const name = segments.at(-1) ?? "";
  if (name === ".env" || name.startsWith(".env.")) return true;
  if (SENSITIVE_FILE_NAMES.has(name)) return true;
  const extensionIndex = name.lastIndexOf(".");
  return extensionIndex >= 0 && SENSITIVE_FILE_EXTENSIONS.has(name.slice(extensionIndex));
}

function scopeRank(scope: TokenScope): number {
  if (scope === "viewer") return 1;
  if (scope === "collaborator") return 2;
  return 3;
}

function maxScope(left: TokenScope, right: TokenScope): TokenScope {
  return scopeRank(left) >= scopeRank(right) ? left : right;
}

function requiredScope(operation: CanonicalToolOperation): TokenScope {
  let required: TokenScope = operation.effect === "read" ? "viewer" : "collaborator";
  for (const path of operation.paths ?? []) {
    if (path.access !== "read") required = maxScope(required, "collaborator");
  }
  if (operation.command || operation.networkDestinations?.length) required = maxScope(required, "collaborator");
  if (operation.minimumActorScope) required = maxScope(required, operation.minimumActorScope);
  return required;
}

function assertInputKey(key: string, allowed: Set<string>): void {
  if (!key || FORBIDDEN_INPUT_KEYS.has(key) || !allowed.has(key)) {
    throw new PolicyDenial("invalid_policy_request", "Policy binding must reference an allowed input key");
  }
}

function readStringInput(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new PolicyDenial("invalid_tool_input", "Bound tool input must be a non-empty string");
  }
  return value;
}

function commandPatternMatches(pattern: RegExp, command: string): boolean {
  const flags = pattern.flags.replace(/[gy]/g, "");
  return new RegExp(pattern.source, flags).test(command);
}

function effectivePort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

async function defaultNetworkResolver(hostname: string): Promise<readonly string[]> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map(({ address }) => address);
}

export class RuntimeNeutralPreToolPolicy {
  private readonly maxInputBytes: number;
  private readonly maxInputDepth: number;
  private readonly maxInputNodes: number;
  private readonly maxStringBytes: number;
  private readonly maxCommandBytes: number;
  private readonly resolveNetworkAddresses: (hostname: string) => Promise<readonly string[]>;

  constructor(private readonly options: PreToolPolicyOptions) {
    this.maxInputBytes = positiveLimit(options.maxInputBytes, DEFAULT_MAX_INPUT_BYTES, "maxInputBytes");
    this.maxInputDepth = positiveLimit(options.maxInputDepth, DEFAULT_MAX_INPUT_DEPTH, "maxInputDepth");
    this.maxInputNodes = positiveLimit(options.maxInputNodes, DEFAULT_MAX_INPUT_NODES, "maxInputNodes");
    this.maxStringBytes = positiveLimit(options.maxStringBytes, DEFAULT_MAX_STRING_BYTES, "maxStringBytes");
    this.maxCommandBytes = positiveLimit(options.maxCommandBytes, DEFAULT_MAX_COMMAND_BYTES, "maxCommandBytes");
    this.resolveNetworkAddresses = options.resolveNetworkAddresses ?? defaultNetworkResolver;
  }

  async evaluate(request: PreToolPolicyRequest): Promise<PreToolPolicyDecision> {
    try {
      return await this.evaluateOrThrow(request);
    } catch (error) {
      if (error instanceof PolicyDenial) {
        return { decision: "deny", code: error.code, reason: error.message, basis: error.basis };
      }
      return {
        decision: "deny",
        code: "policy_evaluation_failed",
        reason: "Tool policy could not safely evaluate this request",
        basis: ["policy_evaluation_failed"],
      };
    }
  }

  private async evaluateOrThrow(request: PreToolPolicyRequest): Promise<PreToolPolicyDecision> {
    if (!request.runtimeId.trim() || !request.toolName.trim() || !request.workspaceId.trim() || !request.sessionId.trim()) {
      throw new PolicyDenial("invalid_policy_request", "Tool policy context is incomplete");
    }
    if (!isAbsolute(request.workspaceRoot)) {
      throw new PolicyDenial("invalid_policy_request", "Tool policy workspace root must be absolute");
    }
    if (!request.actor.id.trim() || request.actor.workspaceId !== request.workspaceId ||
      (request.actor.sessionId !== undefined && request.actor.sessionId !== request.sessionId)) {
      throw new PolicyDenial("actor_context_mismatch", "Tool actor is not bound to this workspace and session");
    }
    const minimumScope = requiredScope(request.operation);
    if (scopeRank(request.actor.scope) < scopeRank(minimumScope)) {
      throw new PolicyDenial("actor_scope_denied", "Tool actor does not have the required scope", [
        "actor_scope_denied",
        `required:${minimumScope}`,
      ]);
    }

    const sanitized = sanitizeJsonValue(request.input, {
      maxDepth: this.maxInputDepth,
      maxNodes: this.maxInputNodes,
      maxStringBytes: this.maxStringBytes,
    }, new Set());
    if (typeof sanitized !== "object" || sanitized === null || Array.isArray(sanitized)) {
      throw new PolicyDenial("invalid_tool_input", "Tool input must be an object");
    }
    if (byteLength(JSON.stringify(sanitized)) > this.maxInputBytes) {
      throw new PolicyDenial("tool_input_too_large", "Tool input exceeds the byte limit");
    }

    const allowedKeys = new Set(request.operation.allowedInputKeys);
    if (allowedKeys.size !== request.operation.allowedInputKeys.length ||
      [...allowedKeys].some((key) => !key || FORBIDDEN_INPUT_KEYS.has(key))) {
      throw new PolicyDenial("invalid_policy_request", "Tool policy contains invalid allowed input keys");
    }
    for (const binding of request.operation.paths ?? []) assertInputKey(binding.inputKey, allowedKeys);
    if (request.operation.command) assertInputKey(request.operation.command.inputKey, allowedKeys);
    for (const binding of request.operation.networkDestinations ?? []) assertInputKey(binding.inputKey, allowedKeys);

    const sourceInput = sanitized as Record<string, unknown>;
    const input = Object.fromEntries(Object.entries(sourceInput).filter(([key]) => allowedKeys.has(key)));
    let modified = Object.keys(sourceInput).length !== Object.keys(input).length;
    const basis = ["actor_scope", "input_schema"];

    const authorizedRoots: string[] = [];
    for (const root of this.options.authorizedRoots) {
      try {
        authorizedRoots.push(await realpath(resolve(root)));
      } catch {
        throw new PolicyDenial("authorized_root_unavailable", "An authorized root could not be resolved");
      }
    }
    if (authorizedRoots.length === 0) {
      throw new PolicyDenial("workspace_root_unauthorized", "No authorized roots are configured");
    }
    const canonicalWorkspace = await canonicalizeToolPath(request.workspaceRoot, request.workspaceRoot);
    if (!canonicalWorkspace.exists || !authorizedRoots.some((root) => isWithin(root, canonicalWorkspace.path))) {
      throw new PolicyDenial("workspace_root_unauthorized", "Workspace root is outside authorized roots");
    }

    const customSensitivePaths: string[] = [];
    for (const sensitivePath of this.options.sensitivePaths ?? []) {
      customSensitivePaths.push((await canonicalizeToolPath(sensitivePath, canonicalWorkspace.path)).path);
    }
    for (const binding of request.operation.paths ?? []) {
      const rawPath = readStringInput(input, binding.inputKey);
      const lexicalPath = isAbsolute(rawPath) ? resolve(rawPath) : resolve(canonicalWorkspace.path, rawPath);
      const canonicalPath = await canonicalizeToolPath(rawPath, canonicalWorkspace.path);
      if (!canonicalPath.exists && !binding.allowMissing) {
        throw new PolicyDenial("path_unavailable", "Tool path does not exist");
      }
      if (!authorizedRoots.some((root) => isWithin(root, canonicalPath.path))) {
        throw new PolicyDenial("path_outside_authorized_roots", "Tool path is outside authorized roots");
      }
      if (isSensitivePath(lexicalPath) || isSensitivePath(canonicalPath.path) ||
        customSensitivePaths.some((sensitivePath) => isWithin(sensitivePath, canonicalPath.path))) {
        throw new PolicyDenial("sensitive_path_denied", "Tool path is protected by sensitive-path policy");
      }
      if (input[binding.inputKey] !== canonicalPath.path) modified = true;
      input[binding.inputKey] = canonicalPath.path;
    }
    if (request.operation.paths?.length) basis.push("canonical_paths", "authorized_roots", "sensitive_paths");

    if (request.operation.command) {
      if (!request.operation.command.sandboxed) {
        throw new PolicyDenial("command_requires_sandbox", "Command execution requires an enforced sandbox");
      }
      const command = readStringInput(input, request.operation.command.inputKey);
      if (byteLength(command) > this.maxCommandBytes) {
        throw new PolicyDenial("tool_input_too_large", "Command exceeds the byte limit");
      }
      for (const pattern of [...DEFAULT_COMMAND_DENY_PATTERNS, ...(this.options.additionalCommandDenyPatterns ?? [])]) {
        if (commandPatternMatches(pattern.pattern, command)) {
          throw new PolicyDenial("command_denied", "Command is denied by mandatory policy", [
            "command_denied",
            `pattern:${pattern.id}`,
          ]);
        }
      }
      basis.push("sandbox_required", "command_patterns");
    }

    for (const binding of request.operation.networkDestinations ?? []) {
      const rawDestination = readStringInput(input, binding.inputKey);
      let destination: URL;
      try {
        destination = new URL(rawDestination);
      } catch {
        throw new PolicyDenial("network_destination_denied", "Network destination must be an absolute URL");
      }
      if ((destination.protocol !== "https:" && destination.protocol !== "http:") ||
        destination.username || destination.password) {
        throw new PolicyDenial("network_destination_denied", "Network destination uses a prohibited URL form");
      }
      const hostname = normalizeHostname(destination.hostname);
      if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
        throw new PolicyDenial("network_destination_denied", "Network destination is not permitted");
      }
      const port = effectivePort(destination);
      const matchingRule = (this.options.networkDestinations ?? []).find((rule) =>
        hostnameMatches(rule.hostname, hostname) &&
        (rule.protocols ?? ["https:"]).includes(destination.protocol as "http:" | "https:") &&
        (!rule.ports || rule.ports.includes(port))
      );
      if (!matchingRule) {
        throw new PolicyDenial("network_destination_denied", "Network destination is not allowlisted");
      }

      let addresses: readonly string[];
      if (isIP(hostname)) {
        addresses = [hostname];
      } else {
        try {
          addresses = await this.resolveNetworkAddresses(hostname);
        } catch {
          throw new PolicyDenial("network_resolution_failed", "Network destination could not be resolved safely");
        }
      }
      if (addresses.length === 0) {
        throw new PolicyDenial("network_resolution_failed", "Network destination did not resolve to an address");
      }
      if (addresses.some((address) => !isPublicIpAddress(address))) {
        throw new PolicyDenial("network_address_denied", "Network destination resolves to a non-public address");
      }

      destination.hash = "";
      destination.hostname = hostname;
      const canonicalDestination = destination.toString();
      if (canonicalDestination !== input[binding.inputKey]) modified = true;
      input[binding.inputKey] = canonicalDestination;
    }
    if (request.operation.networkDestinations?.length) basis.push("network_allowlist", "public_network_address");

    if (modified) basis.push("input_narrowed");
    return { decision: "allow", input, modified, basis };
  }
}
