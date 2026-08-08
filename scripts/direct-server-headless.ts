import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, resolve } from "node:path";

export type DirectServerHeadlessOptions = {
  workspace: string;
  host: string;
  port: number;
  token: string;
  hostToken: string;
  approval?: "auto" | "manual";
  cors?: string;
  opencodeBin?: string;
  verbose?: boolean;
};

export const JUGGLEWORK_HEADLESS_MODELS_URL = "https://work.juggle.im/jwork/models";

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveOpenCodeBin(
  explicit = process.env.JUGGLEWORK_OPENCODE_BIN,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const requested = explicit?.trim() || "opencode";
  if (isAbsolute(requested) || requested.includes("/") || requested.includes("\\")) {
    const absolute = resolve(requested);
    if (await isExecutable(absolute)) return absolute;
    throw new Error(`OpenCode binary not found at ${absolute}`);
  }

  const executableNames = process.platform === "win32"
    ? [requested, `${requested}.exe`, `${requested}.cmd`, `${requested}.bat`]
    : [requested];
  for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of executableNames) {
      const candidate = resolve(directory, name);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  throw new Error(`Unable to resolve OpenCode binary '${requested}' from PATH`);
}

export async function createDirectServerHeadlessLaunch(
  options: DirectServerHeadlessOptions,
  baseEnv: NodeJS.ProcessEnv = process.env,
) {
  const opencodeBin = await resolveOpenCodeBin(options.opencodeBin, baseEnv);
  return {
    env: {
      ...baseEnv,
      JUGGLEWORK_MANAGE_OPENCODE: "1",
      JUGGLEWORK_OPENCODE_BIN: opencodeBin,
      OPENCODE_MODELS_URL: baseEnv.OPENCODE_MODELS_URL?.trim() || JUGGLEWORK_HEADLESS_MODELS_URL,
    },
    args: [
      "--workspace",
      options.workspace,
      "--host",
      options.host,
      "--port",
      String(options.port),
      "--token",
      options.token,
      "--host-token",
      options.hostToken,
      "--approval",
      options.approval ?? "manual",
      "--cors",
      options.cors ?? "*",
      ...(options.verbose === false ? [] : ["--verbose"]),
    ],
    opencodeBin,
  };
}
