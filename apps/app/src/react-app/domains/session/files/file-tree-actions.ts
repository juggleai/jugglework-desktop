export type FileManagerPlatform = "darwin" | "linux" | "windows" | null;

/**
 * 获取当前平台对应的文件管理器定位文案键。
 *
 * @param platform Electron 宿主平台
 */
export function revealLabelKey(platform: FileManagerPlatform): string {
  if (platform === "windows") return "workspace_list.reveal_explorer";
  if (platform === "darwin") return "workspace_list.reveal_finder";
  return "workspace_list.reveal_file_manager";
}
