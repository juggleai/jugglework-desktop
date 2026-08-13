import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { serializeCodexProviderConfig } from "./codex-provider-config.mjs";
import { projectCodexCapabilities } from "./codex-capability-config.mjs";

const LOCAL_SECRET_ENV = "JUGGLEWORK_CODEX_LOCAL_SECRET";

function requiredSegment(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new TypeError(`${label} is required.`);
  return text;
}

function profileKey(organizationId, workspaceId) {
  return createHash("sha256")
    .update(`${organizationId}\u0000${workspaceId}`)
    .digest("hex")
    .slice(0, 32);
}

async function writePrivateFile(targetPath, content) {
  const temporary = `${targetPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, targetPath);
  await chmod(targetPath, 0o600).catch(() => undefined);
}

/**
 * Creates a JuggleWork-owned Codex profile. No path is derived from the user's
 * global Codex installation and the generated config contains no remote token.
 */
export async function writeCodexRuntimeConfig(input) {
  const userDataPath = path.resolve(requiredSegment(input?.userDataPath, "userDataPath"));
  const organizationId = requiredSegment(input?.organizationId, "organizationId");
  const workspaceId = requiredSegment(input?.workspaceId, "workspaceId");
  const brokerBaseUrl = requiredSegment(input?.brokerBaseUrl, "brokerBaseUrl");
  const localSecret = requiredSegment(input?.localSecret, "localSecret");
  const codexHome = path.join(userDataPath, "codex", "profiles", profileKey(organizationId, workspaceId));
  const directories = {
    codexHome,
    sessions: path.join(codexHome, "sessions"),
    logs: path.join(codexHome, "logs"),
    skills: path.join(codexHome, ".agents", "skills"),
  };
  await Promise.all(Object.values(directories).map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
  const provider = {
    providerId: "jugglework_gateway",
    providerName: "JuggleWork Gateway",
    baseUrl: brokerBaseUrl,
    tokenEnv: LOCAL_SECRET_ENV,
    model: requiredSegment(input?.model, "model"),
    reasoningEffort: input?.reasoningEffort ?? "medium",
  };
  const capabilities = await projectCodexCapabilities({
    codexHome,
    workspaceRoot: requiredSegment(input?.workspaceRoot, "workspaceRoot"),
    bundledSkillsDir: input?.bundledSkillsDir,
  });
  await writePrivateFile(path.join(codexHome, "config.toml"), `${serializeCodexProviderConfig(provider)}${capabilities.configToml}`);
  return Object.freeze({
    ...directories,
    model: provider.model,
    providerId: provider.providerId,
    capabilities: Object.freeze({ mcpCount: capabilities.mcpCount, skills: capabilities.skills }),
    // HOME/USERPROFILE prevent Codex from discovering the user's own
    // ~/.agents/skills while preserving a completely separate Codex profile.
    env: Object.freeze({ CODEX_HOME: codexHome, HOME: codexHome, USERPROFILE: codexHome, [LOCAL_SECRET_ENV]: localSecret, ...capabilities.env }),
  });
}

export const CODEX_LOCAL_SECRET_ENV = LOCAL_SECRET_ENV;
