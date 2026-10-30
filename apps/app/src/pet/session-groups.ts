import type { PetTarget } from "@/app/lib/desktop-pet-types";

/** 会话由宿主按最近更新时间排序；首次出现的工作区即最近工作区。 */
export function groupPetSessions(sessions: PetTarget[]) {
  const groups = new Map<string, { workspaceId: string; project: string; sessions: PetTarget[] }>();
  for (const session of sessions) {
    let group = groups.get(session.workspaceId);
    if (!group) {
      group = { workspaceId: session.workspaceId, project: session.project, sessions: [] };
      groups.set(session.workspaceId, group);
    }
    group.sessions.push(session);
  }
  return [...groups.values()];
}
