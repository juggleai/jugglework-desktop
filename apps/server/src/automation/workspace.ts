import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { workspaceIdForPath } from "../workspaces.js";
import type { WorkspaceInfo } from "../types.js";

export function automationWorkspaceRoot(): string {
  return process.env.JUGGLEWORK_AUTOMATION_ROOT?.trim() || join(homedir(), "Documents", "JuggleWork", "Automations");
}

export function automationDirectoryName(value: string): string {
  const name = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64).replace(/_+$/, "");
  return !name || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(name) ? "scheduled_task" : name;
}

export async function allocateAutomationWorkspace(input: { name: string; directoryName: string; timezone: string; now: number; root?: string }): Promise<WorkspaceInfo> {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: input.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(input.now);
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  const parent = join(input.root ?? automationWorkspaceRoot(), `${part("year")}-${part("month")}-${part("day")}`);
  await mkdir(parent, { recursive: true });
  const slug = automationDirectoryName(input.directoryName);
  for (let suffix = 1; suffix <= 10000; suffix++) {
    const path = join(parent, suffix === 1 ? slug : `${slug}_${suffix}`);
    try {
      await mkdir(path);
      return { id: workspaceIdForPath(path), path, name: input.name, preset: "starter", workspaceType: "local" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("无法分配定时任务目录：同名目录过多");
}
