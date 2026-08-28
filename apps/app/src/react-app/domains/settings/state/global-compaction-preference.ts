import { applyEdits, modify, parse } from "jsonc-parser";

import {
  EMPTY_OPENCODE_CONFIG,
  readGlobalOpencodeConfig,
  writeGlobalOpencodeConfig,
  type GlobalConfigTarget,
} from "./global-opencode-config";

/** 自动压缩上下文的读写目标，与其他全局 OpenCode 配置项共用。 */
export type GlobalCompactionTarget = GlobalConfigTarget;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 把 `compaction.auto` 写进全局配置内容，保留其余键与 JSONC 注释。 */
export function formatConfigWithAutoCompaction(raw: string, auto: boolean): string {
  const base = raw.trim() ? raw : EMPTY_OPENCODE_CONFIG;
  const updated = applyEdits(
    base,
    modify(base, ["compaction", "auto"], auto, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    }),
  );
  return updated.endsWith("\n") ? updated : `${updated}\n`;
}

/** 从全局配置内容解析 `compaction.auto`，未显式设置时视为开启。 */
export function readAutoCompactionFromConfig(raw: string | null | undefined): boolean {
  if (!raw?.trim()) return true;
  const parsed = parse(raw) as Record<string, unknown> | undefined;
  const compaction = isRecord(parsed?.compaction) ? parsed.compaction : undefined;
  return compaction?.auto !== false;
}

/** 读取全局自动压缩设置。配置不可读时返回默认值 `true`。 */
export async function readGlobalAutoCompaction(target: GlobalCompactionTarget): Promise<boolean> {
  const content = await readGlobalOpencodeConfig(target);
  return readAutoCompactionFromConfig(content);
}

/**
 * 写入全局自动压缩设置，并清除当前工作区运行时层遗留的 `compaction`。
 *
 * TIPS: OpenCode 的配置合并中工作区级优先于全局级，工作区运行时层残留的
 * `compaction.auto` 会静默压过新写入的全局值，导致开关状态与实际行为不符。
 * 因此清理不是可选项；但它必须发生在全局写入成功之后，全局写入失败时不能
 * 动工作区配置，否则用户会同时丢掉两处设置。
 */
export async function writeGlobalAutoCompaction(
  target: GlobalCompactionTarget,
  auto: boolean,
): Promise<void> {
  const current = await readGlobalOpencodeConfig(target);
  if (current === null) {
    throw new Error("Global opencode config is not writable in this runtime.");
  }
  await writeGlobalOpencodeConfig(target, formatConfigWithAutoCompaction(current, auto));

  const workspaceId = target.workspaceId.trim();
  if (!target.juggleworkClient || !workspaceId) return;
  try {
    await target.juggleworkClient.patchConfig(workspaceId, { opencode: { compaction: null } });
  } catch {
    // 清理失败不回滚全局写入：全局值已是用户期望，遗留的工作区值会在下次
    // 切换开关时再次尝试清除。
  }
}
