/** @jsxImportSource react */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

export type WorkspaceShellActions = {
  openTaskSearch: () => void;
  openCreateWorkspace: () => void;
};

type WorkspaceShellActionsContextValue = {
  actions: WorkspaceShellActions;
  register: (actions: WorkspaceShellActions) => () => void;
};

const WorkspaceShellActionsContext = createContext<WorkspaceShellActionsContextValue | null>(null);

export function WorkspaceShellActionsProvider({ children }: { children: ReactNode }) {
  const registeredActionsRef = useRef<WorkspaceShellActions | null>(null);

  const register = useCallback((actions: WorkspaceShellActions) => {
    registeredActionsRef.current = actions;
    return () => {
      if (registeredActionsRef.current === actions) {
        registeredActionsRef.current = null;
      }
    };
  }, []);

  const actions = useMemo<WorkspaceShellActions>(() => ({
    openTaskSearch: () => registeredActionsRef.current?.openTaskSearch(),
    openCreateWorkspace: () => registeredActionsRef.current?.openCreateWorkspace(),
  }), []);

  const value = useMemo(() => ({ actions, register }), [actions, register]);

  return (
    <WorkspaceShellActionsContext.Provider value={value}>
      {children}
    </WorkspaceShellActionsContext.Provider>
  );
}

function useWorkspaceShellActionsContext() {
  const context = useContext(WorkspaceShellActionsContext);
  if (!context) {
    throw new Error("Workspace shell actions must be used within WorkspaceShellActionsProvider");
  }
  return context;
}

export function useWorkspaceShellActions() {
  return useWorkspaceShellActionsContext().actions;
}

export function useRegisterWorkspaceShellActions(actions: WorkspaceShellActions) {
  const { register } = useWorkspaceShellActionsContext();

  useEffect(() => register(actions), [actions, register]);
}
