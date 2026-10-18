import { create } from "zustand";

export type DesktopUpdateIndicatorStatus = {
  state: "idle" | "checking" | "available" | "blocked" | "downloading" | "ready" | "error";
  version?: string;
  downloadedBytes?: number;
  totalBytes?: number | null;
} | null;

type DesktopUpdateAction = () => void | Promise<void>;

type DesktopUpdateIndicatorController = {
  owner: symbol;
  status: DesktopUpdateIndicatorStatus;
  downloadUpdate: DesktopUpdateAction;
  installUpdateAndRestart: DesktopUpdateAction;
};

type DesktopUpdateIndicatorStore = {
  controller: DesktopUpdateIndicatorController | null;
  register: (controller: DesktopUpdateIndicatorController) => void;
  updateStatus: (owner: symbol, status: DesktopUpdateIndicatorStatus) => void;
  clear: (owner: symbol) => void;
};

/**
 * Shares the single enabled Electron updater controller with every retained app
 * surface. Several navigation Rails can be mounted at once, but they all read
 * the same update identity and therefore cannot accidentally create competing
 * check/download flows.
 */
export const useDesktopUpdateIndicatorStore = create<DesktopUpdateIndicatorStore>((set) => ({
  controller: null,
  register: (controller) => set({ controller }),
  updateStatus: (owner, status) => set((current) => (
    current.controller?.owner === owner && current.controller.status !== status
      ? { controller: { ...current.controller, status } }
      : current
  )),
  clear: (owner) => set((current) => (
    current.controller?.owner === owner ? { controller: null } : current
  )),
}));
