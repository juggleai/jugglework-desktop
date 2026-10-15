import { readdir, writeFile, mkdir, rm, lstat, realpath } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import type { SkillItem } from "./types.js";
import { parseFrontmatter, buildFrontmatter } from "./frontmatter.js";
import { exists } from "./utils.js";
import { validateDescription, validateSkillName } from "./validators.js";
import { ApiError } from "./errors.js";
import { projectSkillsDir } from "./workspace-files.js";
import { readBoundedRegularTextFile } from "./jsonc.js";

const SKILL_DETAIL_MAX_BYTES = 5 * 1024 * 1024;
const SKILL_DETAIL_MAX_FILES = 800;
const BUNDLED_SKILL_MARKER_MAX_BYTES = 4096;
const BUNDLED_SKILL_MARKER_FILE = ".jugglework-managed-skill.json";
const BUNDLED_SKILL_MARKER_OWNER = "jugglework-desktop:public-skill";

export type SkillDetailFile = {
  relPath: string;
  size: number;
};

export type SkillDetail = {
  item: SkillItem;
  content: string;
  files: SkillDetailFile[];
};

async function findWorkspaceRoots(workspaceRoot: string): Promise<string[]> {
  const roots: string[] = [];
  let current = resolve(workspaceRoot);
  while (true) {
    roots.push(current);
    const gitPath = join(current, ".git");
    if (await exists(gitPath)) break;
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  return roots;
}

const extractTriggerFromBody = (body: string) => {
  const lines = body.split(/\r?\n/);
  let inWhenSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (/^#{1,6}\s+/.test(trimmed)) {
      const heading = trimmed.replace(/^#{1,6}\s+/, "").trim();
      inWhenSection = /^when to use$/i.test(heading);
      continue;
    }

    if (!inWhenSection) continue;

    const cleaned = trimmed
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .trim();

    if (cleaned) return cleaned;
  }

  return "";
};

async function parseSkillEntry(
  skillPath: string,
  entryName: string,
  scope: "project" | "global",
): Promise<SkillItem | null> {
  let content: string;
  try {
    content = await readBoundedRegularTextFile(skillPath, { maxBytes: SKILL_DETAIL_MAX_BYTES });
  } catch (error) {
    if (["FILE_TOO_LARGE", "ELOOP", "NOT_REGULAR_FILE"].includes(errorCode(error))) return null;
    throw error;
  }
  const { data, body } = parseFrontmatter(content);
  const name = typeof data.name === "string" ? data.name : entryName;
  const description = typeof data.description === "string" ? data.description : "";
  const trigger =
    typeof data.trigger === "string"
      ? data.trigger
      : typeof data.when === "string"
        ? data.when
        : extractTriggerFromBody(body);
  try {
    validateSkillName(name);
    validateDescription(description);
  } catch {
    return null;
  }
  if (name !== entryName) return null;
  return {
    name,
    description,
    path: skillPath,
    scope,
    trigger: trigger.trim() || undefined,
  };
}

async function listSkillsInDir(dir: string, scope: "project" | "global"): Promise<SkillItem[]> {
  if (!(await exists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const items: SkillItem[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = join(dir, entry.name, "SKILL.md");
    if (await exists(skillPath)) {
      // Direct skill: <dir>/<name>/SKILL.md
      const item = await parseSkillEntry(skillPath, entry.name, scope);
      if (item) items.push(item);
    } else {
      // Domain/category folder: <dir>/<domain>/<name>/SKILL.md – scan one level deeper.
      // This supports the convention where global skills are organised as
      //   skills/<domain>/<skill-name>/SKILL.md
      // in addition to the flat   skills/<skill-name>/SKILL.md  layout.
      const domainDir = join(dir, entry.name);
      let subEntries: Dirent[];
      try {
        subEntries = await readdir(domainDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const subEntry of subEntries) {
        if (!subEntry.isDirectory()) continue;
        const subSkillPath = join(domainDir, subEntry.name, "SKILL.md");
        if (!(await exists(subSkillPath))) continue;
        const item = await parseSkillEntry(subSkillPath, subEntry.name, scope);
        if (item) items.push(item);
      }
    }
  }
  return items;
}

async function isPublicSkillPath(skillPath: string): Promise<boolean> {
  try {
    const marker = JSON.parse(await readBoundedRegularTextFile(
      join(dirname(skillPath), BUNDLED_SKILL_MARKER_FILE),
      { maxBytes: BUNDLED_SKILL_MARKER_MAX_BYTES },
    )) as unknown;
    if (!marker || typeof marker !== "object" || Array.isArray(marker)) return false;
    const record = marker as Record<string, unknown>;
    return Object.keys(record).length === 3
      && record.schemaVersion === 1
      && record.owner === BUNDLED_SKILL_MARKER_OWNER
      && typeof record.digest === "string"
      && /^sha256:[a-f0-9]{64}$/.test(record.digest);
  } catch {
    return false;
  }
}

/**
 * 全局技能目录集合
 * @param input.homeDir 主目录覆盖，仅供测试注入；缺省取当前用户主目录
 *
 * 列出与删除必须共用同一份目录清单，否则会出现"列得出来但删不掉"。
 */
export function globalSkillDirs(input?: { homeDir?: string; opencodeConfigDir?: string }): string[] {
  const home = input?.homeDir ?? homedir();
  return [
    join(input?.opencodeConfigDir?.trim() || process.env.OPENCODE_CONFIG_DIR?.trim() || join(home, ".config", "opencode"), "skills"),
    join(home, ".claude", "skills"),
    join(home, ".agents", "skills"),
    join(home, ".agent", "skills"),
  ].map((dir) => resolve(dir));
}

export async function listSkills(
  workspaceRoot: string,
  includeGlobal: boolean,
  options?: {
    homeDir?: string;
    opencodeConfigDir?: string;
    scope?: "project" | "global";
    ownerPluginIdForPath?: (path: string) => string | undefined;
  },
): Promise<SkillItem[]> {
  const items: SkillItem[] = [];
  if (options?.scope !== "global") {
    const roots = await findWorkspaceRoots(workspaceRoot);
    for (const root of roots) {
      const opencodeDir = join(root, ".opencode", "skills");
      const claudeDir = join(root, ".claude", "skills");
      items.push(...(await listSkillsInDir(opencodeDir, "project")));
      items.push(...(await listSkillsInDir(claudeDir, "project")));
    }
  }

  if (includeGlobal || options?.scope === "global") {
    for (const dir of globalSkillDirs(options)) {
      items.push(...(await listSkillsInDir(dir, "global")));
    }
  }

  const annotated = await Promise.all(items.map(async (item): Promise<SkillItem> => {
    const ownerPluginId = options?.ownerPluginIdForPath?.(resolve(item.path));
    if (ownerPluginId) return { ...item, ownerPluginId, sourceKind: "plugin" };
    if (item.scope === "global" && await isPublicSkillPath(item.path)) return { ...item, sourceKind: "public" };
    return { ...item, sourceKind: "standalone" };
  }));
  const seen = new Set<string>();
  return annotated.filter((item) => {
    // Preserve independently owned entries when their names collide.
    const key = `${item.name}\0${item.sourceKind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object" || !("code" in error)) return "";
  return typeof error.code === "string" ? error.code : "";
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relPath = relative(root, candidate);
  return relPath !== "" && relPath !== ".." && !relPath.startsWith(`..${sep}`) && !isAbsolute(relPath);
}

function normalizedRelativePath(root: string, candidate: string): string {
  return relative(root, candidate).split(sep).join("/");
}

function validateSkillDetailPath(path: string): void {
  if (!path || path.includes("\0") || !isAbsolute(path)) {
    throw new ApiError(400, "invalid_skill_path", "Skill path must be an absolute path without NUL bytes");
  }
  if (path.split(/[\\/]/).some((segment) => segment === "." || segment === "..")) {
    throw new ApiError(400, "invalid_skill_path", "Skill path must not contain dot segments");
  }
  if (basename(path) !== "SKILL.md" || path.split(/[\\/]/).at(-1) !== "SKILL.md") {
    throw new ApiError(400, "invalid_skill_path", "Skill path must end with SKILL.md");
  }
}

async function resolveSafeSkillPath(root: string, candidate: string): Promise<{ realCandidate: string; realSkillDir: string }> {
  let realRoot: string;
  try {
    const rootMetadata = await lstat(root);
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
      throw new ApiError(400, "unsafe_skill_path", "Global skill root must be a real directory");
    }
    realRoot = await realpath(root);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (errorCode(error) === "ENOENT") {
      throw new ApiError(404, "skill_not_found", `Skill not found: ${candidate}`);
    }
    throw error;
  }

  const relPath = relative(root, candidate);
  let current = root;
  for (const segment of relPath.split(sep)) {
    current = join(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        throw new ApiError(404, "skill_not_found", `Skill not found: ${candidate}`);
      }
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      throw new ApiError(400, "unsafe_skill_path", "Skill path must not contain symbolic links");
    }
    if (current === candidate) {
      if (!metadata.isFile()) {
        throw new ApiError(400, "unsafe_skill_path", "SKILL.md must be a regular file");
      }
      if (metadata.size > SKILL_DETAIL_MAX_BYTES) {
        throw new ApiError(413, "skill_too_large", `SKILL.md exceeds ${SKILL_DETAIL_MAX_BYTES} bytes`);
      }
    }
  }

  const realCandidate = await realpath(candidate);
  if (!isWithinRoot(realRoot, realCandidate)) {
    throw new ApiError(400, "unsafe_skill_path", "Skill path escapes its global skill root");
  }

  return { realCandidate, realSkillDir: await realpath(dirname(candidate)) };
}

async function enumerateSkillFiles(skillDir: string, realSkillDir: string): Promise<SkillDetailFile[]> {
  const files: SkillDetailFile[] = [];

  const visit = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) continue;

      const resolvedPath = await realpath(path);
      if (!isWithinRoot(realSkillDir, resolvedPath)) {
        throw new ApiError(400, "unsafe_skill_path", "Skill resource escapes its skill directory");
      }
      if (metadata.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!metadata.isFile()) continue;
      if (entry.name === BUNDLED_SKILL_MARKER_FILE && dir === skillDir) continue;
      if (files.length >= SKILL_DETAIL_MAX_FILES) {
        throw new ApiError(413, "skill_file_limit_exceeded", `Skill contains more than ${SKILL_DETAIL_MAX_FILES} files`);
      }
      files.push({ relPath: normalizedRelativePath(skillDir, path), size: metadata.size });
    }
  };

  await visit(skillDir);
  files.sort((left, right) => left.relPath < right.relPath ? -1 : left.relPath > right.relPath ? 1 : 0);
  return files;
}

export async function readSkillDetail(
  workspaceRoot: string,
  input: { scope: string; path: string },
  options?: {
    homeDir?: string;
    opencodeConfigDir?: string;
    ownerPluginIdForPath?: (path: string) => string | undefined;
  },
): Promise<SkillDetail> {
  if (input.scope !== "global") {
    throw new ApiError(400, "invalid_skill_scope", "Only global skill details are supported");
  }
  validateSkillDetailPath(input.path);

  const root = globalSkillDirs(options).find((candidate) => isWithinRoot(candidate, input.path));
  if (!root) {
    throw new ApiError(400, "unsafe_skill_path", "Skill path is outside the global skill roots");
  }

  const { realCandidate, realSkillDir } = await resolveSafeSkillPath(root, input.path);
  const catalog = await listSkills(workspaceRoot, true, { ...options, scope: "global" });
  const item = catalog.find((candidate) => candidate.path === input.path);
  if (!item) {
    throw new ApiError(404, "skill_not_found", `Skill not found: ${input.path}`);
  }

  let content: string;
  try {
    content = await readBoundedRegularTextFile(realCandidate, { maxBytes: SKILL_DETAIL_MAX_BYTES });
  } catch (error) {
    const code = errorCode(error);
    if (code === "FILE_TOO_LARGE") {
      throw new ApiError(413, "skill_too_large", `SKILL.md exceeds ${SKILL_DETAIL_MAX_BYTES} bytes`);
    }
    if (code === "ELOOP" || code === "NOT_REGULAR_FILE") {
      throw new ApiError(400, "unsafe_skill_path", "SKILL.md must be a regular file without symbolic links");
    }
    if (code === "ENOENT") {
      throw new ApiError(404, "skill_not_found", `Skill not found: ${input.path}`);
    }
    throw error;
  }

  return {
    item,
    content,
    files: await enumerateSkillFiles(dirname(input.path), realSkillDir),
  };
}

export type UpsertSkillPayload = {
  name: string;
  content: string;
  description?: string;
};

export function buildSkillContent(payload: UpsertSkillPayload): { name: string; content: string } {
  const name = payload.name.trim();
  validateSkillName(name);
  if (!payload.content) {
    throw new ApiError(400, "invalid_skill_content", "Skill content is required");
  }

  let content = payload.content;
  const { data, body } = parseFrontmatter(payload.content);
  if (Object.keys(data).length > 0) {
    const frontmatterName = typeof data.name === "string" ? data.name : "";
    const frontmatterDescription = typeof data.description === "string" ? data.description : "";
    if (frontmatterName && frontmatterName !== name) {
      throw new ApiError(400, "invalid_skill_name", "Skill frontmatter name must match payload name");
    }
    validateDescription(frontmatterDescription || payload.description);
    const nextDescription = frontmatterDescription || payload.description || "";
    const frontmatter = buildFrontmatter({
      ...data,
      name,
      description: nextDescription,
    });
    content = frontmatter + body.replace(/^\n/, "");
  } else {
    validateDescription(payload.description);
    const frontmatter = buildFrontmatter({ name, description: payload.description });
    content = frontmatter + payload.content.replace(/^\n/, "");
  }

  return {
    name,
    content: content.endsWith("\n") ? content : content + "\n",
  };
}

export async function upsertSkill(
  workspaceRoot: string,
  payload: UpsertSkillPayload,
): Promise<{ path: string; action: "added" | "updated" }> {
  const skill = buildSkillContent(payload);

  const baseDir = projectSkillsDir(workspaceRoot);
  const skillDir = join(baseDir, skill.name);
  await mkdir(skillDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");
  const existed = await exists(skillPath);
  await writeFile(skillPath, skill.content, "utf8");
  return { path: skillPath, action: existed ? "updated" : "added" };
}

/**
 * 删除技能
 * @param workspaceRoot 工作区根目录
 * @param name 技能名
 * @param scope 作用域：project 只在工作区技能目录内解析，global 只在全局技能目录内解析
 * @param options.homeDir 主目录覆盖，仅供测试注入
 *
 * TIPS: 两个作用域严格互不越界——以 project 请求删除一个只存在于全局的技能必须
 * 报未找到，反之亦然。否则设置页的全局技能页会误删工作区文件。
 */
export async function deleteSkill(
  workspaceRoot: string,
  name: string,
  scope: "project" | "global" = "project",
  options?: { homeDir?: string; opencodeConfigDir?: string },
): Promise<{ path: string }> {
  const trimmed = name.trim();
  validateSkillName(trimmed);

  if (scope === "global") {
    for (const dir of globalSkillDirs(options)) {
      const items = await listSkillsInDir(dir, "global");
      const item = items.find((skill) => skill.name === trimmed);
      if (!item) continue;
      const skillDir = dirname(item.path);
      await rm(skillDir, { recursive: true, force: true });
      return { path: skillDir };
    }
    throw new ApiError(404, "skill_not_found", `Skill not found: ${trimmed}`);
  }

  const baseDir = projectSkillsDir(workspaceRoot);
  const flatDir = join(baseDir, trimmed);
  if (await exists(join(flatDir, "SKILL.md"))) {
    await rm(flatDir, { recursive: true, force: true });
    return { path: flatDir };
  }
  // Nested layout: skills/<domain>/<name>/SKILL.md (e.g. skills installed by
  // marketplace plugin bundles are namespaced under a plugin folder). Listing
  // supports this layout, so deletion must resolve it the same way.
  const items = await listSkills(workspaceRoot, false);
  const item = items.find((skill) => skill.name === trimmed && skill.scope === "project");
  if (!item) {
    throw new ApiError(404, "skill_not_found", `Skill not found: ${trimmed}`);
  }
  const skillDir = dirname(item.path);
  await rm(skillDir, { recursive: true, force: true });
  return { path: skillDir };
}
