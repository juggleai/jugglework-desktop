import { sanitizeDiagnosticValue } from "./diagnostic-sanitizer.js";
import type { McpItem } from "./types.js";

const DEFAULT_HANDOFF_TTL_MS = 60 * 60_000;
const MAX_HANDOFF_TTL_MS = 60 * 60_000;
const SENSITIVE_HEADER = /(authorization|token|secret|cookie|api[-_]?key)/i;

export type ClaudeMcpCredentialLease = {
  headers: Record<string, string>;
  expiresAt: number;
  release?: () => void | Promise<void>;
};

export interface ClaudeMcpCredentialBroker {
  lease(input: {
    workspaceId: string;
    serverName: string;
    serverUrl: string;
    configuration: Readonly<Record<string, unknown>>;
    expiresAt: number;
  }): Promise<ClaudeMcpCredentialLease | null>;
}

export type ClaudeMcpRuntimeServer = {
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
  credentialExpiresAt?: number;
  timeoutMs?: number;
  alwaysLoad?: boolean;
};

export type ClaudeMcpRuntimeConfiguration = {
  workspaceId: string;
  revision: number;
  generatedAt: number;
  servers: Record<string, ClaudeMcpRuntimeServer>;
};

export type ClaudeMcpHandoffDiagnostic = {
  serverName: string;
  state: "approved" | "denied" | "pending";
  code: "mcp_handoff_approved" | "mcp_policy_denied" | "mcp_needs_auth" | "mcp_credential_expired" | "mcp_configuration_invalid";
  retryable: boolean;
};

export type ClaudeMcpRuntimeConfigurationResult = {
  configuration: ClaudeMcpRuntimeConfiguration;
  diagnostics: ClaudeMcpHandoffDiagnostic[];
  release(): Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function bearerJwtExpiration(headers: Record<string, string>): number | null {
  const authorization = Object.entries(headers).find(([name]) => name.toLowerCase() === "authorization")?.[1];
  const token = authorization?.match(/^Bearer\s+([^\s]+)$/i)?.[1];
  const payload = token?.split(".")[1];
  if (!payload) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof decoded.exp === "number" && Number.isFinite(decoded.exp) ? decoded.exp * 1_000 : null;
  } catch {
    return null;
  }
}

function configuredExpiration(configuration: Record<string, unknown>, headers: Record<string, string>): number | null {
  const direct = configuration.credentialExpiresAt ?? configuration.expiresAt ?? configuration.expires_at;
  if (typeof direct === "number" && Number.isSafeInteger(direct) && direct > 0) {
    return direct < 10_000_000_000 ? direct * 1_000 : direct;
  }
  return bearerJwtExpiration(headers);
}

function remoteServer(configuration: Record<string, unknown>): Omit<ClaudeMcpRuntimeServer, "headers" | "credentialExpiresAt"> | null {
  if (configuration.enabled === false || configuration.type !== "remote" || typeof configuration.url !== "string") return null;
  try {
    const url = new URL(configuration.url);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.hash) return null;
    const transport = configuration.transport === "sse" ? "sse" : "http";
    const timeout = configuration.timeout;
    return {
      type: transport,
      url: url.toString(),
      ...(typeof timeout === "number" && Number.isSafeInteger(timeout) && timeout >= 1_000 ? { timeoutMs: timeout } : {}),
      ...(typeof configuration.alwaysLoad === "boolean" ? { alwaysLoad: configuration.alwaysLoad } : {}),
    };
  } catch {
    return null;
  }
}

function hasSensitiveHeaders(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((name) => SENSITIVE_HEADER.test(name));
}

export async function createClaudeMcpRuntimeConfiguration(input: {
  workspaceId: string;
  revision: number;
  items: McpItem[];
  credentialBroker?: ClaudeMcpCredentialBroker;
  now?: () => number;
  handoffTtlMs?: number;
}): Promise<ClaudeMcpRuntimeConfigurationResult> {
  const now = input.now?.() ?? Date.now();
  const ttl = Math.min(Math.max(1_000, input.handoffTtlMs ?? DEFAULT_HANDOFF_TTL_MS), MAX_HANDOFF_TTL_MS);
  const handoffExpiresAt = now + ttl;
  const servers: Record<string, ClaudeMcpRuntimeServer> = {};
  const diagnostics: ClaudeMcpHandoffDiagnostic[] = [];
  const releases: Array<() => void | Promise<void>> = [];

  for (const item of input.items) {
    if (item.source !== "config.remote" || item.disabledByTools) {
      diagnostics.push({ serverName: item.name, state: "denied", code: "mcp_policy_denied", retryable: false });
      continue;
    }
    const base = remoteServer(item.config);
    if (!base) {
      diagnostics.push({ serverName: item.name, state: "denied", code: "mcp_configuration_invalid", retryable: false });
      continue;
    }

    const configuredHeaders = stringRecord(item.config.headers);
    const needsBroker = isRecord(item.config.oauth) || item.config.oauth === true || hasSensitiveHeaders(configuredHeaders);
    let lease: ClaudeMcpCredentialLease | null = null;
    if (needsBroker && input.credentialBroker) {
      lease = await input.credentialBroker.lease({
        workspaceId: input.workspaceId,
        serverName: item.name,
        serverUrl: base.url,
        configuration: item.config,
        expiresAt: handoffExpiresAt,
      });
    } else if (needsBroker) {
      const expiresAt = configuredExpiration(item.config, configuredHeaders);
      if (expiresAt !== null) lease = { headers: configuredHeaders, expiresAt };
    }

    if (needsBroker && !lease) {
      diagnostics.push({ serverName: item.name, state: "pending", code: "mcp_needs_auth", retryable: true });
      continue;
    }
    if (lease && (lease.expiresAt <= now || lease.expiresAt > handoffExpiresAt)) {
      await lease.release?.();
      diagnostics.push({ serverName: item.name, state: "denied", code: "mcp_credential_expired", retryable: true });
      continue;
    }
    if (lease?.release) releases.push(lease.release);
    servers[item.name] = {
      ...base,
      ...(lease ? { headers: { ...lease.headers }, credentialExpiresAt: lease.expiresAt } : {}),
      ...(!needsBroker && Object.keys(configuredHeaders).length ? { headers: configuredHeaders } : {}),
    };
    diagnostics.push({ serverName: item.name, state: "approved", code: "mcp_handoff_approved", retryable: false });
  }

  return {
    configuration: { workspaceId: input.workspaceId, revision: input.revision, generatedAt: now, servers },
    diagnostics,
    async release() {
      await Promise.allSettled(releases.map((release) => Promise.resolve(release())));
    },
  };
}

export function inspectClaudeMcpRuntimeConfiguration(input: ClaudeMcpRuntimeConfigurationResult): unknown {
  return sanitizeDiagnosticValue({
    workspaceId: input.configuration.workspaceId,
    revision: input.configuration.revision,
    generatedAt: input.configuration.generatedAt,
    servers: Object.keys(input.configuration.servers),
    diagnostics: input.diagnostics,
  });
}
