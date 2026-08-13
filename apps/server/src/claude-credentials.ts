import { isAbsolute, relative } from "node:path";
import { realpath, stat } from "node:fs/promises";
import type { ClaudeAdvancedRollout } from "./claude-advanced-rollout.js";

export const ANTHROPIC_API_KEY_SECRET = "anthropic_api_key" as const;
export const CLAUDE_GATEWAY_CREDENTIAL_SECRET = "claude_gateway_credential" as const;
export const AWS_BEARER_TOKEN_BEDROCK_SECRET = "aws_bearer_token_bedrock" as const;
export const AWS_ACCESS_KEY_ID_SECRET = "aws_access_key_id" as const;
export const AWS_SECRET_ACCESS_KEY_SECRET = "aws_secret_access_key" as const;
export const AWS_SESSION_TOKEN_SECRET = "aws_session_token" as const;
export const FOUNDRY_API_KEY_SECRET = "foundry_api_key" as const;
export const FOUNDRY_AUTH_TOKEN_SECRET = "foundry_auth_token" as const;

export type ClaudeSecretName =
  | typeof ANTHROPIC_API_KEY_SECRET
  | typeof CLAUDE_GATEWAY_CREDENTIAL_SECRET
  | typeof AWS_BEARER_TOKEN_BEDROCK_SECRET
  | typeof AWS_ACCESS_KEY_ID_SECRET
  | typeof AWS_SECRET_ACCESS_KEY_SECRET
  | typeof AWS_SESSION_TOKEN_SECRET
  | typeof FOUNDRY_API_KEY_SECRET
  | typeof FOUNDRY_AUTH_TOKEN_SECRET;

export type ClaudeCredentialProvider = "anthropic" | "gateway" | "bedrock" | "vertex" | "foundry";
export type ClaudeCredentialAuthMethod =
  | "api_key"
  | "bearer_token"
  | "access_key"
  | "application_default_credentials";
export type ClaudeCredentialReasonCode =
  | "credential_ready"
  | "credential_missing"
  | "credential_store_unavailable"
  | "credential_invalid"
  | "provider_not_approved"
  | "provider_configuration_invalid";

export interface ClaudeSecretProvider {
  getSecret(name: ClaudeSecretName): Promise<string | null>;
}

export type ClaudeCredentialReadiness = {
  ready: boolean;
  reasonCode: ClaudeCredentialReasonCode;
  provider?: ClaudeCredentialProvider;
  authMethod?: ClaudeCredentialAuthMethod;
};

export interface ClaudeCredentialLease {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly diagnostic?: Readonly<{ provider: ClaudeCredentialProvider; authMethod: ClaudeCredentialAuthMethod }>;
  release(): void | Promise<void>;
}

export interface ClaudeCredentialBroker {
  readiness(): Promise<ClaudeCredentialReadiness>;
  acquire(): Promise<ClaudeCredentialLease>;
}

export type ClaudeCredentialPolicy = {
  approvedProviders: readonly ClaudeCredentialProvider[];
  approvedGatewayOrigins?: readonly string[];
  approvedFoundryOrigins?: readonly string[];
  approvedCredentialRoots?: readonly string[];
};

export class ClaudeCredentialError extends Error {
  constructor(
    readonly code: Exclude<ClaudeCredentialReasonCode, "credential_ready">,
    message: string,
    readonly provider: ClaudeCredentialProvider = "anthropic",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ClaudeCredentialError";
  }
}

function validSecret(value: string | null): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 16_384
    && !/[\r\n\0]/.test(value);
}

function validSetting(value: string, maximum = 2_048): boolean {
  return value.length > 0 && value.length <= maximum && !/[\r\n\0]/.test(value);
}

function validRegion(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

function approved(policy: ClaudeCredentialPolicy, provider: ClaudeCredentialProvider): boolean {
  return policy.approvedProviders.includes(provider);
}

function safeHttpsUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash ? url : null;
  } catch {
    return null;
  }
}

function pathWithin(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    if (!isAbsolute(root)) return false;
    const candidate = relative(root, path);
    return candidate === "" || (!candidate.startsWith("..") && !isAbsolute(candidate));
  });
}

abstract class BaseClaudeCredentialBroker implements ClaudeCredentialBroker {
  abstract readonly provider: ClaudeCredentialProvider;
  abstract readonly authMethod: ClaudeCredentialAuthMethod;

  constructor(protected readonly policy: ClaudeCredentialPolicy) {}

  protected policyReadiness(): ClaudeCredentialReadiness | null {
    return approved(this.policy, this.provider) ? null : this.result(false, "provider_not_approved");
  }

  protected result(ready: boolean, reasonCode: ClaudeCredentialReasonCode): ClaudeCredentialReadiness {
    return { ready, reasonCode, provider: this.provider, authMethod: this.authMethod };
  }

  protected lease(environment: NodeJS.ProcessEnv, clear: () => void): ClaudeCredentialLease {
    const leasedEnvironment = { ...environment };
    let released = false;
    return Object.freeze({
      environment: leasedEnvironment,
      diagnostic: Object.freeze({ provider: this.provider, authMethod: this.authMethod }),
      release() {
        if (released) return;
        released = true;
        for (const name of Object.keys(leasedEnvironment)) delete leasedEnvironment[name];
        clear();
      },
    });
  }

  abstract readiness(): Promise<ClaudeCredentialReadiness>;
  abstract acquire(): Promise<ClaudeCredentialLease>;
}

export class RolloutGatedClaudeCredentialBroker implements ClaudeCredentialBroker {
  constructor(
    private readonly broker: ClaudeCredentialBroker,
    private readonly rollout: ClaudeAdvancedRollout,
  ) {}

  async readiness(): Promise<ClaudeCredentialReadiness> {
    const readiness = await this.broker.readiness();
    if (!readiness.provider || readiness.provider === "anthropic") return readiness;
    return this.rollout.enabled(`provider-${readiness.provider}`)
      ? readiness
      : { ready: false, reasonCode: "provider_not_approved", provider: readiness.provider, authMethod: readiness.authMethod };
  }

  async acquire(): Promise<ClaudeCredentialLease> {
    const readiness = await this.broker.readiness();
    if (readiness.provider && readiness.provider !== "anthropic"
      && !this.rollout.use(`provider-${readiness.provider}`)) {
      throw new ClaudeCredentialError("provider_not_approved", `${readiness.provider} authentication is disabled by rollout policy`, readiness.provider);
    }
    return this.broker.acquire();
  }
}

async function readSecret(
  source: ClaudeSecretProvider,
  name: ClaudeSecretName,
  provider: ClaudeCredentialProvider,
): Promise<string | null> {
  try {
    return await source.getSecret(name);
  } catch (cause) {
    throw new ClaudeCredentialError(
      "credential_store_unavailable",
      `${provider} credentials could not be read from secure storage`,
      provider,
      { cause },
    );
  }
}

export class AnthropicByokCredentialBroker extends BaseClaudeCredentialBroker {
  readonly provider = "anthropic" as const;
  readonly authMethod = "api_key" as const;

  constructor(private readonly source: ClaudeSecretProvider, policy: ClaudeCredentialPolicy = { approvedProviders: ["anthropic"] }) {
    super(policy);
  }

  async readiness(): Promise<ClaudeCredentialReadiness> {
    const denied = this.policyReadiness();
    if (denied) return denied;
    try {
      const secret = await this.source.getSecret(ANTHROPIC_API_KEY_SECRET);
      return this.result(validSecret(secret), validSecret(secret) ? "credential_ready" : "credential_missing");
    } catch {
      return this.result(false, "credential_store_unavailable");
    }
  }

  async acquire(): Promise<ClaudeCredentialLease> {
    if (!approved(this.policy, this.provider)) {
      throw new ClaudeCredentialError("provider_not_approved", "Anthropic authentication is not approved by policy", this.provider);
    }
    let secret = await readSecret(this.source, ANTHROPIC_API_KEY_SECRET, this.provider);
    if (!validSecret(secret)) throw new ClaudeCredentialError("credential_missing", "Anthropic credentials are not configured", this.provider);
    return this.lease({ ANTHROPIC_API_KEY: secret }, () => { secret = null; });
  }
}

export class ApprovedGatewayCredentialBroker extends BaseClaudeCredentialBroker {
  readonly provider = "gateway" as const;
  readonly authMethod: "api_key" | "bearer_token";
  private readonly baseUrl: string;

  constructor(
    private readonly source: ClaudeSecretProvider,
    options: { baseUrl: string; credentialType: "api_key" | "bearer_token"; policy: ClaudeCredentialPolicy },
  ) {
    super(options.policy);
    this.baseUrl = options.baseUrl;
    this.authMethod = options.credentialType;
  }

  private configurationValid(): boolean {
    const url = safeHttpsUrl(this.baseUrl);
    if (!url) return false;
    return (this.policy.approvedGatewayOrigins ?? []).some((origin) => safeHttpsUrl(origin)?.origin === url.origin);
  }

  async readiness(): Promise<ClaudeCredentialReadiness> {
    const denied = this.policyReadiness();
    if (denied) return denied;
    if (!this.configurationValid()) return this.result(false, "provider_configuration_invalid");
    try {
      const secret = await this.source.getSecret(CLAUDE_GATEWAY_CREDENTIAL_SECRET);
      return this.result(validSecret(secret), validSecret(secret) ? "credential_ready" : "credential_missing");
    } catch {
      return this.result(false, "credential_store_unavailable");
    }
  }

  async acquire(): Promise<ClaudeCredentialLease> {
    if (!approved(this.policy, this.provider)) throw new ClaudeCredentialError("provider_not_approved", "Gateway authentication is not approved by policy", this.provider);
    if (!this.configurationValid()) throw new ClaudeCredentialError("provider_configuration_invalid", "Gateway configuration is not approved by policy", this.provider);
    let secret = await readSecret(this.source, CLAUDE_GATEWAY_CREDENTIAL_SECRET, this.provider);
    if (!validSecret(secret)) throw new ClaudeCredentialError("credential_missing", "Gateway credentials are not configured", this.provider);
    return this.lease({
      ANTHROPIC_BASE_URL: this.baseUrl,
      [this.authMethod === "api_key" ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN"]: secret,
    }, () => { secret = null; });
  }
}

export class AwsBedrockCredentialBroker extends BaseClaudeCredentialBroker {
  readonly provider = "bedrock" as const;
  readonly authMethod: "bearer_token" | "access_key";

  constructor(
    private readonly source: ClaudeSecretProvider,
    private readonly options: { region: string; authMethod: "bearer_token" | "access_key"; policy: ClaudeCredentialPolicy },
  ) {
    super(options.policy);
    this.authMethod = options.authMethod;
  }

  private configurationValid(): boolean { return validRegion(this.options.region); }

  async readiness(): Promise<ClaudeCredentialReadiness> {
    const denied = this.policyReadiness();
    if (denied) return denied;
    if (!this.configurationValid()) return this.result(false, "provider_configuration_invalid");
    try {
      if (this.authMethod === "bearer_token") {
        const secret = await this.source.getSecret(AWS_BEARER_TOKEN_BEDROCK_SECRET);
        return this.result(validSecret(secret), validSecret(secret) ? "credential_ready" : "credential_missing");
      }
      const accessKey = await this.source.getSecret(AWS_ACCESS_KEY_ID_SECRET);
      const secretKey = await this.source.getSecret(AWS_SECRET_ACCESS_KEY_SECRET);
      const ready = validSecret(accessKey) && /^[A-Za-z0-9]{16,128}$/.test(accessKey) && validSecret(secretKey);
      return this.result(ready, ready ? "credential_ready" : "credential_missing");
    } catch {
      return this.result(false, "credential_store_unavailable");
    }
  }

  async acquire(): Promise<ClaudeCredentialLease> {
    if (!approved(this.policy, this.provider)) throw new ClaudeCredentialError("provider_not_approved", "Bedrock authentication is not approved by policy", this.provider);
    if (!this.configurationValid()) throw new ClaudeCredentialError("provider_configuration_invalid", "Bedrock region is invalid", this.provider);
    if (this.authMethod === "bearer_token") {
      let token = await readSecret(this.source, AWS_BEARER_TOKEN_BEDROCK_SECRET, this.provider);
      if (!validSecret(token)) throw new ClaudeCredentialError("credential_missing", "Bedrock credentials are not configured", this.provider);
      return this.lease({ CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: this.options.region, AWS_BEARER_TOKEN_BEDROCK: token }, () => { token = null; });
    }
    let accessKey = await readSecret(this.source, AWS_ACCESS_KEY_ID_SECRET, this.provider);
    let secretKey = await readSecret(this.source, AWS_SECRET_ACCESS_KEY_SECRET, this.provider);
    let sessionToken = await readSecret(this.source, AWS_SESSION_TOKEN_SECRET, this.provider);
    if (!validSecret(accessKey) || !/^[A-Za-z0-9]{16,128}$/.test(accessKey) || !validSecret(secretKey)) {
      throw new ClaudeCredentialError("credential_missing", "Bedrock access key credentials are not configured", this.provider);
    }
    if (sessionToken !== null && !validSecret(sessionToken)) throw new ClaudeCredentialError("credential_invalid", "Bedrock session credentials are invalid", this.provider);
    return this.lease({
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: this.options.region,
      AWS_ACCESS_KEY_ID: accessKey,
      AWS_SECRET_ACCESS_KEY: secretKey,
      ...(sessionToken ? { AWS_SESSION_TOKEN: sessionToken } : {}),
    }, () => { accessKey = null; secretKey = null; sessionToken = null; });
  }
}

export class GoogleVertexCredentialBroker extends BaseClaudeCredentialBroker {
  readonly provider = "vertex" as const;
  readonly authMethod = "application_default_credentials" as const;

  constructor(private readonly options: {
    projectId: string;
    region: string;
    applicationCredentialsPath: string;
    policy: ClaudeCredentialPolicy;
  }) { super(options.policy); }

  private async configurationValid(): Promise<boolean> {
    if (!validSetting(this.options.projectId, 256)
      || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(this.options.projectId)
      || !validRegion(this.options.region)
      || !isAbsolute(this.options.applicationCredentialsPath)
      || !validSetting(this.options.applicationCredentialsPath, 4_096)) return false;
    try {
      const [credentialPath, credentialStat] = await Promise.all([
        realpath(this.options.applicationCredentialsPath),
        stat(this.options.applicationCredentialsPath),
      ]);
      if (!credentialStat.isFile()) return false;
      const roots = await Promise.all((this.policy.approvedCredentialRoots ?? []).map((root) => realpath(root)));
      return pathWithin(credentialPath, roots);
    } catch {
      return false;
    }
  }

  async readiness(): Promise<ClaudeCredentialReadiness> {
    const denied = this.policyReadiness();
    if (denied) return denied;
    return await this.configurationValid()
      ? this.result(true, "credential_ready")
      : this.result(false, "provider_configuration_invalid");
  }

  async acquire(): Promise<ClaudeCredentialLease> {
    if (!approved(this.policy, this.provider)) throw new ClaudeCredentialError("provider_not_approved", "Vertex authentication is not approved by policy", this.provider);
    if (!await this.configurationValid()) throw new ClaudeCredentialError("provider_configuration_invalid", "Vertex credential configuration is invalid", this.provider);
    return this.lease({
      CLAUDE_CODE_USE_VERTEX: "1",
      CLOUD_ML_REGION: this.options.region,
      ANTHROPIC_VERTEX_PROJECT_ID: this.options.projectId,
      GOOGLE_APPLICATION_CREDENTIALS: this.options.applicationCredentialsPath,
    }, () => undefined);
  }
}

export class MicrosoftFoundryCredentialBroker extends BaseClaudeCredentialBroker {
  readonly provider = "foundry" as const;
  readonly authMethod: "api_key" | "bearer_token";

  constructor(
    private readonly source: ClaudeSecretProvider,
    private readonly options: {
      resource?: string;
      baseUrl?: string;
      authMethod: "api_key" | "bearer_token";
      policy: ClaudeCredentialPolicy;
    },
  ) {
    super(options.policy);
    this.authMethod = options.authMethod;
  }

  private configurationValid(): boolean {
    const resource = this.options.resource?.trim() ?? "";
    const baseUrl = this.options.baseUrl?.trim() ?? "";
    if (validSetting(resource, 256) && /^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(resource) && !baseUrl) return true;
    const url = !resource ? safeHttpsUrl(baseUrl) : null;
    return Boolean(url && (this.policy.approvedFoundryOrigins ?? []).some((origin) => safeHttpsUrl(origin)?.origin === url.origin));
  }

  private secretName(): ClaudeSecretName {
    return this.authMethod === "api_key" ? FOUNDRY_API_KEY_SECRET : FOUNDRY_AUTH_TOKEN_SECRET;
  }

  async readiness(): Promise<ClaudeCredentialReadiness> {
    const denied = this.policyReadiness();
    if (denied) return denied;
    if (!this.configurationValid()) return this.result(false, "provider_configuration_invalid");
    try {
      const secret = await this.source.getSecret(this.secretName());
      return this.result(validSecret(secret), validSecret(secret) ? "credential_ready" : "credential_missing");
    } catch {
      return this.result(false, "credential_store_unavailable");
    }
  }

  async acquire(): Promise<ClaudeCredentialLease> {
    if (!approved(this.policy, this.provider)) throw new ClaudeCredentialError("provider_not_approved", "Foundry authentication is not approved by policy", this.provider);
    if (!this.configurationValid()) throw new ClaudeCredentialError("provider_configuration_invalid", "Foundry resource configuration is invalid", this.provider);
    let secret = await readSecret(this.source, this.secretName(), this.provider);
    if (!validSecret(secret)) throw new ClaudeCredentialError("credential_missing", "Foundry credentials are not configured", this.provider);
    return this.lease({
      CLAUDE_CODE_USE_FOUNDRY: "1",
      ...(this.options.resource ? { ANTHROPIC_FOUNDRY_RESOURCE: this.options.resource } : { ANTHROPIC_FOUNDRY_BASE_URL: this.options.baseUrl }),
      [this.authMethod === "api_key" ? "ANTHROPIC_FOUNDRY_API_KEY" : "ANTHROPIC_FOUNDRY_AUTH_TOKEN"]: secret,
    }, () => { secret = null; });
  }
}
