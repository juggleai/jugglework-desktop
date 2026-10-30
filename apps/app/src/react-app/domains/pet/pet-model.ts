import type { Session } from "@opencode-ai/sdk/v2/client";
import type { PetTask } from "@/app/lib/desktop-pet-types";
import type { sessionTaskPresentation } from "../session/status/task-presentation";

/** 后代按最近活动排序；真实执行优先于委派工具，等待仍具有最高优先级。 */
export function selectPetTaskPresentation(own: ReturnType<typeof sessionTaskPresentation>, descendants: ReturnType<typeof sessionTaskPresentation>[]) {
  const items = [own, ...descendants];
  return items.find((item) => item.waiting)
    ?? [...descendants, own].find((item) => item.active && item.currentToolName && item.currentToolName !== "task")
    ?? descendants.find((item) => item.active)
    ?? (own.active ? own : descendants.find((item) => item.resumable))
    ?? own;
}

/** 失联期间保留未确认任务，既有同轮完成事实不因无关同步失败退回执行态。 */
export function reconcilePetTaskConnection(task: PetTask, previous: PetTask | undefined, unavailable: boolean, statusText: string): PetTask {
  if (!unavailable || task.state === "waiting") return task;
  if (task.state === "completed" && (!previous || (previous.state === "completed" && previous.turnKey === task.turnKey))) return task;
  return { ...task, state: "reconciling", statusText, progressText: undefined };
}

/** 找出根任务及其后代；未知、归档主任务不会自动成为通用输入目标。 */
export function sessionTreeIds(sessions: Iterable<Pick<Session, "id" | "parentID">>, root: string) {
  const items = [...sessions];
  const result = new Set([root]);
  let added = true;
  while (added) {
    added = false;
    for (const session of items) if (session.parentID && result.has(session.parentID) && !result.has(session.id)) { result.add(session.id); added = true; }
  }
  return result;
}

/** 以更新时间、创建时间和稳定键排序全项目可发送的主会话，排除子会话和归档项。 */
export function sortedRoots<T extends { key: string; session: Pick<Session, "parentID" | "time"> }>(items: T[]) {
  return items.filter((item) => !item.session.parentID && !item.session.time.archived)
    .sort((a,b) => (b.session.time.updated ?? b.session.time.created) - (a.session.time.updated ?? a.session.time.created) || a.key.localeCompare(b.key));
}

/** 获取全项目最新主会话，不改变已固定的编辑目标。 */
export function latestRoot<T extends { key: string; session: Pick<Session, "parentID" | "time"> }>(items: T[]) {
  return sortedRoots(items)[0];
}
