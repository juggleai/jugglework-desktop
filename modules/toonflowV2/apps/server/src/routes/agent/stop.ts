import { Router } from "express";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { cancelAgentRequest } from "@/utils/agentRuns";
import u from "@/utils";

const schema = z.strictObject({ runId: z.uuid(), directory: z.string().min(1).max(4096) });

export default Router().post("/", async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json(error("Agent 停止参数无效", null, 400)); return; }
  // Session auth is installed before routes. Resolve the original project grant,
  // never a current-session/global "stop" or caller-supplied process identifier.
  const directory = await u.workspace.resolveWorkspace(req, parsed.data.directory);
  res.json(success(await cancelAgentRequest(parsed.data.runId, directory)));
});
