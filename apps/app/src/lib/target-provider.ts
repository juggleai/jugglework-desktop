import * as React from "react";

import type { OpenTarget } from "@/react-app/domains/session/artifacts/open-target";

export type OpenTargetOptions = {
  auto?: boolean;
  external?: boolean;
  reveal?: boolean;
};

type OpenTargetHandler = (target: OpenTarget, options?: OpenTargetOptions) => void;

type OpenTargetContextValue = {
  openTargets: OpenTarget[];
  onOpenTarget: OpenTargetHandler | undefined;
};

type OpenTargetProviderProps = {
  children: React.ReactNode;
  openTargets?: OpenTarget[] | undefined;
  onOpenTarget?: OpenTargetHandler | undefined;
};

const EMPTY_OPEN_TARGETS: OpenTarget[] = [];
const FileReferenceContext = React.createContext<OpenTarget[]>(EMPTY_OPEN_TARGETS);

/** 为单轮消息限定可引用文件，不将其他轮次的同名文件注入正文。 */
export function FileReferenceProvider({ children, targets }: { children: React.ReactNode; targets: OpenTarget[] }) {
  return React.createElement(FileReferenceContext.Provider, { value: targets }, children);
}

/** 读取当前消息轮次中已确认的文件引用。 */
export function useFileReferences() {
  return React.useContext(FileReferenceContext);
}

const OpenTargetContext = React.createContext<OpenTargetContextValue>({
  openTargets: EMPTY_OPEN_TARGETS,
  onOpenTarget: undefined,
});

export function OpenTargetProvider({
  children,
  openTargets = EMPTY_OPEN_TARGETS,
  onOpenTarget,
}: OpenTargetProviderProps) {
  const value = React.useMemo(
    () => ({
      openTargets,
      onOpenTarget,
    }),
    [openTargets, onOpenTarget],
  );

  return React.createElement(OpenTargetContext.Provider, { value }, children);
}

export function useOpenTargets() {
  return React.useContext(OpenTargetContext);
}
