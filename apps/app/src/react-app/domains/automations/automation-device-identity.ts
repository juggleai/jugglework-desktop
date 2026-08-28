const DEVICE_ID_KEY = "jugglework.automation.device-id.v1";

/** 返回普通重启和升级后保持稳定的 Desktop 安装身份。 */
export function readAutomationDeviceId(): string {
  const current = localStorage.getItem(DEVICE_ID_KEY)?.trim();
  if (current) return current;
  const created = crypto.randomUUID();
  localStorage.setItem(DEVICE_ID_KEY, created);
  return created;
}
