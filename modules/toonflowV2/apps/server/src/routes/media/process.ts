import { Router } from "express";
import { z } from "zod";
import { success, error } from "@/lib/responseFormat";
import { isManagedMode } from "@/lib/managed";
import { hostFetch } from "@/utils/jugglework";
import u from "@/utils";

const base = { directory: z.string().min(1).max(4096), path: z.string().min(1).max(4096) };
const output = { ...base, outputDirectory: z.string().min(1).max(4000) };
const schema = z.discriminatedUnion("operation", [
  z.strictObject({ ...base, operation: z.literal("probe") }),
  z.strictObject({ ...output, operation: z.literal("extractAudio") }),
  z.strictObject({ ...output, operation: z.literal("separate") }),
  z.strictObject({ ...output, operation: z.literal("trim"), start: z.number().nonnegative(), end: z.number().positive() }),
  z.strictObject({ ...output, operation: z.literal("analyze"), threshold: z.number().min(0.05).max(0.9), minSceneSeconds: z.number().min(0.1).max(30) }),
]);

export default Router().post("/", async (req, res) => {
  if (!isManagedMode()) { res.status(403).json(error("此操作需要 JuggleWork 宿主", null, 403)); return; }
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json(error("媒体参数无效", parsed.error.issues, 400)); return; }
  const directory = await u.workspace.resolveWorkspace(req, parsed.data.directory);
  const controller = new AbortController();
  const close = () => { if (!res.writableEnded) controller.abort(); };
  res.once("close", close);
  req.once("aborted", close);
  try {
    const result = await (await hostFetch("/videoEdit", { ...parsed.data, directory }, controller.signal)).json();
    if (!res.destroyed) res.json(success(result));
  } finally {
    res.off("close", close);
    req.off("aborted", close);
  }
});
