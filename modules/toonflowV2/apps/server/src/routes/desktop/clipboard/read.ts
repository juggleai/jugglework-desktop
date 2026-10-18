import { Router } from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";

// ACT: 读取也使用 POST，复用 desktopRequest 的同源校验。
export default Router().post("/", async (req, res) => {
  res.json(success({ text: await u.desktop.getDesktopRuntime(req).readClipboardText() ?? "" }));
});
