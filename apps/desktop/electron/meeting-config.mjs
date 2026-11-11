import { readFile } from "node:fs/promises";

export async function readMeetingConfig(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT")
      return { enabled: true, appId: 0, filePath };
    throw new Error("无法读取 Desktop 会议配置文件");
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Desktop 会议配置不是有效 JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Desktop 会议配置必须是 JSON 对象");
  if ("serverSecret" in value || "appSign" in value)
    throw new Error("服务端密钥不能放在 Desktop 会议配置中");
  const { enabled = true, appId = 0 } = value;
  if (
    typeof enabled !== "boolean" ||
    !Number.isInteger(appId) ||
    appId < 0 ||
    appId > 4294967295
  )
    throw new Error("Desktop 会议配置字段无效");
  return { enabled, appId, filePath };
}
