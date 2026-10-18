import { Router } from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { isManagedMode } from "@/lib/managed";

export default Router().get("/", async (req, res) => {
  const settings = u.a2aSettings.getA2aSettings();
  const base = u.a2aSettings.getA2aUrl(req);
  const agents = (await u.teams.listTeams()).map(team => team.kind === "local" && team.enabled && settings.enabled
    ? { ...team, cardUrl: `${base}/${team.name}/.well-known/agent-card.json` } : team);
  res.json(success({ agents, canManage: !isManagedMode() && u.workspace.isLocalWorkspaceRequest(req) }));
});
