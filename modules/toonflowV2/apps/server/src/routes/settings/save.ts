import u from "@/utils";
import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";
import { maxSystemPromptLength } from "@/agent/runtime/prompt";
import { isManagedMode, managedSettingsKeys } from "@/lib/managed";

const router = Router();

export default router.put("/", validateFields({ settings: z.record(z.string(), z.json()).and(z.object({
  agentSystemPrompt: z.string().max(maxSystemPromptLength, `系统提示词不能超过 ${maxSystemPromptLength} 个字符`).optional(),
  desktopUpdateSource: z.enum(["official", "github", "custom"]).optional(),
  desktopUpdateCustomUrl: z.string().max(2048).refine(value => !value || u.desktop.isValidUpdateUrl(value),
    "自定义更新源必须是不含账号、查询参数或锚点的 HTTP(S) 地址").optional(),
  mcp: z.object({ enabled: z.boolean().optional(), token: z.string().optional(), port: z.number().int().min(1).max(65535).optional() }).optional(),
})).refine(value => value.desktopUpdateSource !== "custom" || !!value.desktopUpdateCustomUrl, {
  path: ["desktopUpdateCustomUrl"], message: "选择自定义更新源前，请先填写有效地址",
}) }), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const { settings } = req.body;
  if (isManagedMode()) {
    const forbidden = Object.keys(settings).filter(key => !managedSettingsKeys.has(key));
    if (forbidden.length) return res.status(403).json(error(`JuggleWork managed 模式不允许保存设置项：${forbidden.join("、")}`, null, 403));
    u.conf.set("settings", { ...u.conf.get("settings", {}), ...settings });
    res.json(success(null, "设置已保存"));
    return;
  }
  delete settings.juggleworkManaged;
  delete settings.juggleworkModelError;
  u.removeLegacySettings(settings);
  u.conf.set("settings", settings);
  await u.mcpRuntime.reloadMcpRuntime();
  res.json(success(null, "设置已保存"));
});
