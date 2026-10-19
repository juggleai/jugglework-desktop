import { getComposerOfficeGroups, useComposerStateStore } from "../surface/composer-state-store";
import { toast } from "@/components/ui/sonner";

const pending = new Set<string>();

/**
 * 在文件面板状态提交前检查选区；无选区保持原同步行为，确认和准备成功才执行状态修改。
 * @param sessionId 文件所属聊天
 * @param path 目标工作区相对路径，真实文件身份仍由宿主预检
 * @param commit 原有文件状态修改，不更改正文、附件或排队任务
 */
export function commitOfficeFileSwitch(sessionId: string, path: string, commit: () => void): void {
  const references = getComposerOfficeGroups(useComposerStateStore.getState(), sessionId).flatMap((group) => group.references);
  if (!references.length || references.every((ref) => ref.preview.path === path)) { commit(); return; }
  if (pending.has(sessionId)) return;
  const confirm = typeof window !== "undefined" ? window.__JUGGLEWORK_ELECTRON__?.office?.confirmFileSwitch : undefined;
  if (!confirm) { toast.error("请在桌面应用中切换含文档选区的文件"); return; }
  pending.add(sessionId);
  void confirm({ workspaceId: references[0].workspaceId, sessionId, path }).then((accepted) => {
    if (accepted) commit();
  }).catch((error) => toast.error(error instanceof Error ? error.message : String(error))).finally(() => pending.delete(sessionId));
}
