import * as React from "react";

const SessionSurfaceVisibilityContext = React.createContext(true);

/** 会话面的显示状态只控制原生视图展示，不控制任务或文档实例生命周期。 */
export function SessionSurfaceVisibilityProvider({
  surfaceVisible,
  children,
}: {
  surfaceVisible: boolean;
  children: React.ReactNode;
}) {
  return (
    <SessionSurfaceVisibilityContext.Provider value={surfaceVisible}>
      {children}
    </SessionSurfaceVisibilityContext.Provider>
  );
}

/** 独立使用文件面板时默认可见。 */
export function useSessionSurfaceVisible(): boolean {
  return React.useContext(SessionSurfaceVisibilityContext);
}
