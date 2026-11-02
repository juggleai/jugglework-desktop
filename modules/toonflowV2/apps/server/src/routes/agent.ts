import { Router } from "express";
import { z } from "zod";
import type { CanvasInfo } from "@toonflow/tools-scaffold/runtime";
import type { AgentEvent } from "@/agent/runtime/types";
import { cancelAgentRequest, runAgentRequest } from "@/utils/agentRuns";
import { error } from "@/lib/responseFormat";
import u from "@/utils";

const inputSchema = z.strictObject({
  runId: z.uuid(), prompt: z.string().trim(), directory: z.string().min(1).max(4096),
  attachments: u.agent.agentAttachmentsSchema.optional(),
  providerId: z.string().min(1), modelId: z.string().min(1),
  thinkingLevel: z.enum(["off", "low", "medium", "high"]).optional(),
  sessionFile: z.string().regex(/^[\w-]+\.jsonl$/).optional(),
  resendFrom: z.string().min(1).max(128).optional(),
  canvas: z.strictObject({
    id: z.string().min(1).max(256),
    tools: z.array(z.strictObject({
      nodeId: z.string().min(1).max(256),
      name: z.string().max(101).regex(/^node:[a-z][a-zA-Z0-9]*$/),
      nodeLabel: z.string().max(200).optional(),
      description: z.string().max(4000),
      parameters: z.record(z.string(), z.json()).refine(value => value.type === "object", "函数参数必须是 object JSON Schema"),
    })).max(1000),
  }).optional(),
});

export default Router().post("/", async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const parsed = inputSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json(error("Agent 参数无效", null, 400)); return; }
  const { runId, directory, canvas, ...options } = parsed.data;
  const send = (event: AgentEvent) => {
    u.agent.trackAgentEvent(directory, options.sessionFile, event);
    if (!res.destroyed) res.write(`${JSON.stringify(event)}\n`);
  };
  const cancel = () => { void cancelAgentRequest(runId, directory).catch(error => console.error("Agent 取消清理失败", error)); };
  const close = () => { if (!res.writableEnded) cancel(); };
  res.once("close", close);
  try {
    await runAgentRequest(runId, directory, async signal => {
      const cwd = await u.workspace.resolveWorkspace(req, directory);
      if (cwd !== directory) throw new Error("Agent 目录必须是规范项目目录");
      signal.throwIfAborted();
      res.set({ "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
      res.flushHeaders();
      const bridge = canvas ? u.canvas.createCanvasContext(cwd, canvas as CanvasInfo, send) : undefined;
      const questions = u.question.createQuestionContext(cwd, send, cancel);
      const dispose = () => { bridge?.dispose(); questions.dispose(); };
      signal.addEventListener("abort", dispose, { once: true });
      try {
        await u.agent.run({ ...options, cwd, canvas: bridge?.context, question: questions.context, signal }, send);
        signal.throwIfAborted();
      } finally {
        signal.removeEventListener("abort", dispose);
        dispose();
      }
    });
    send({ type: "done" });
  } catch (error) {
    if (!res.headersSent) res.set({ "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache" });
    send({ type: "error", message: error instanceof Error ? error.message : "Agent 运行失败" });
  } finally {
    res.off("close", close);
    res.end();
  }
});
