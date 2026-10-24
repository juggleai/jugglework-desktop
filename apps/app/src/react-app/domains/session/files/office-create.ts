import type {
  FileWindowBridge,
  OfficeCreationKind,
} from "@jugglework/types/file-window";

/** 调用宿主创建动作；只有确认成功的路径才进入现有文件查看器。 */
export async function createOfficeFile(
  bridge: FileWindowBridge,
  input: {
    workspaceId: string;
    sessionId: string;
    kind: OfficeCreationKind;
  },
  open: (file: { path: string; name: string }) => void | Promise<void>,
): Promise<boolean> {
  const created = await bridge.create(input);
  if (!created) return false;
  await open({
    path: created.path,
    name: created.path.split("/").pop() ?? created.path,
  });
  return true;
}
