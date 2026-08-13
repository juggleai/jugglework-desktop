import { createHash, randomBytes } from "node:crypto";
import { cp, mkdir, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { parse } from "jsonc-parser";

const BLOCKED_ENV = new Set(["CODEX_HOME", "JUGGLEWORK_CODEX_LOCAL_SECRET"]);
const safeName = (value) => String(value).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
const toml = (value) => JSON.stringify(String(value));
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

async function directory(target) {
  try { return (await stat(target)).isDirectory(); } catch { return false; }
}

async function readProjectConfig(workspaceRoot) {
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    try { return parse(await readFile(path.join(workspaceRoot, name), "utf8")) ?? {}; } catch { /* absent/invalid */ }
  }
  return {};
}

function projectMcp(config) {
  const result = [];
  /** @type {Record<string, string>} */
  const processEnv = {};
  const entries = Object.entries(config?.mcp ?? config?.mcpServers ?? {});
  for (const [rawName, value] of entries) {
    if (!value || typeof value !== "object" || value.enabled === false) continue;
    const name = safeName(rawName);
    if (!name) continue;
    const lines = [`[mcp_servers.${name}]`];
    const command = Array.isArray(value.command) ? value.command.map(String) : [];
    if (command.length > 0) {
      lines.push(`command = ${toml(command[0])}`);
      if (command.length > 1) lines.push(`args = [${command.slice(1).map(toml).join(", ")}]`);
      const envNames = [];
      for (const [key, secret] of Object.entries(value.environment ?? value.env ?? {})) {
        if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || BLOCKED_ENV.has(key) || typeof secret !== "string") continue;
        processEnv[key] = secret;
        envNames.push(key);
      }
      if (envNames.length) lines.push(`env_vars = [${envNames.map(toml).join(", ")}]`);
    } else if (typeof value.url === "string" && /^https?:\/\//.test(value.url)) {
      lines.push(`url = ${toml(value.url)}`);
      const headers = [];
      for (const [header, secret] of Object.entries(value.headers ?? {})) {
        if (typeof secret !== "string") continue;
        const envName = `JUGGLEWORK_CODEX_MCP_${createHash("sha256").update(`${name}\0${header}`).digest("hex").slice(0, 16).toUpperCase()}`;
        processEnv[envName] = secret;
        headers.push(`${toml(header)} = ${toml(envName)}`);
      }
      if (headers.length) lines.push(`env_http_headers = { ${headers.join(", ")} }`);
    } else continue;
    result.push(lines.join("\n"));
  }
  return { toml: result.length ? `${result.join("\n\n")}\n` : "", env: processEnv, count: result.length };
}

async function collectSkills(root, source, output) {
  if (!root || !(await directory(root))) return;
  const trustedRoot = await realpath(root);
  for (const entry of await readdir(trustedRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const candidate = path.join(trustedRoot, entry.name);
    const resolved = await realpath(candidate).catch(() => null);
    if (!resolved || !inside(trustedRoot, resolved)) continue;
    const skillFile = path.join(resolved, "SKILL.md");
    let content;
    try { content = await readFile(skillFile, "utf8"); } catch { continue; }
    output.push({ id: safeName(entry.name), source, path: resolved, version: createHash("sha256").update(content).digest("hex").slice(0, 16) });
  }
}

/** Projects only app-bundled and workspace-trusted capabilities into an isolated profile. */
export async function projectCodexCapabilities(input) {
  const workspaceRoot = await realpath(path.resolve(input.workspaceRoot));
  const codexHome = path.resolve(input.codexHome);
  const skills = [];
  await collectSkills(input.bundledSkillsDir, "bundled", skills);
  for (const relative of [path.join(".opencode", "skills"), path.join(".opencode", "skill"), path.join(".agents", "skills"), path.join(".codex", "skills")]) {
    await collectSkills(path.join(workspaceRoot, relative), "workspace", skills);
  }
  const agentsHome = path.join(codexHome, ".agents");
  await mkdir(agentsHome, { recursive: true, mode: 0o700 });
  const temporary = path.join(agentsHome, `.skills-${randomBytes(6).toString("hex")}`);
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  for (const skill of skills) await cp(skill.path, path.join(temporary, skill.id), { recursive: true, force: true });
  const target = path.join(agentsHome, "skills");
  await rm(target, { recursive: true, force: true });
  await rename(temporary, target);
  const mcp = projectMcp(await readProjectConfig(workspaceRoot));
  return { configToml: mcp.toml, env: Object.freeze(mcp.env), skills: Object.freeze(skills.map(({ path: _path, ...skill }) => skill)), mcpCount: mcp.count };
}
