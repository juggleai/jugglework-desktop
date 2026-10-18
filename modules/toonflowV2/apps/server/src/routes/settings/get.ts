import { isJugglework, hostTextProviders } from "@/utils/jugglework";
import u from "@/utils";
import { Router } from "express";
import { success } from "@/lib/responseFormat";
import { isManagedMode, managedSettings } from "@/lib/managed";

const router = Router();

export default router.get("/", async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  res.set("Cache-Control", "no-store");
  const settings = u.conf.get("settings", {});
  const managed = isManagedMode();
  const visibleSettings = managed ? managedSettings(settings) : settings;
  if (!isJugglework) {
    res.json(success({ ...visibleSettings, juggleworkManaged: managed, ...(managed ? { customProviders: [], mediaProviderConfigs: {}, juggleworkModelError: "JuggleWork 模型桥接未配置" } : {}) }));
    return;
  }
  let customProviders: Awaited<ReturnType<typeof hostTextProviders>> = [];
  let juggleworkModelError = "";
  try { customProviders = await hostTextProviders(); }
  catch (error) { juggleworkModelError = error instanceof Error ? error.message : "模型服务不可用"; }
  res.json(success({ ...visibleSettings, customProviders: customProviders.map(provider => ({ ...provider, apiKey: "", apiUrl: "" })), mediaProviderConfigs: {}, juggleworkManaged: managed, juggleworkModelError }));
});
