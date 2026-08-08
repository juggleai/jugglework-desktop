export function createRuntimeIpcHandlers(runtimeManager) {
  return {
    runtimeStatus: () => runtimeManager.runtimeStatus(),
    workspaceActivate: (input) => runtimeManager.workspaceActivate(input ?? {}),
    engineDispose: (workspacePath) => runtimeManager.engineDispose(String(workspacePath ?? "").trim()),
  };
}
