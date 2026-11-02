import { Router } from "express";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { isManagedMode } from "@/lib/managed";
import { hostFetch } from "@/utils/jugglework";
import u from "@/utils";

const schema = z.strictObject({ requestId: z.uuid(), directory: z.string().min(1).max(4096) });

export default Router().post("/", async (req, res) => {
  if (!isManagedMode()) { res.status(403).json(error("此操作需要 JuggleWork 宿主", null, 403)); return; }
  u.mcpControl.assertAppRequest(req);
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json(error("媒体取消参数无效", null, 400)); return; }
  const input = parsed.data;
  // The original task owns authorization. Cancellation must still work after
  // grant revocation; the host checks the exact task/directory and generation.
  const result = await (await hostFetch("/videoEditCancel", input, AbortSignal.timeout(30_000))).json();
  res.json(success(result));
});
