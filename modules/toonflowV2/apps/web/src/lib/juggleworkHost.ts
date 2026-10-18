import axios from "axios";
import { nextTick } from "vue";
import type { Router } from "vue-router";

import { useWorkspaceStore, type Project } from "@/stores/workspace";
import useWorkspaceFiles from "@/lib/workspaceFiles";
import { flushWorkspaceSave, waitForWorkspaceReady } from "@/lib/mcpControl";
import { isCanvasFile } from "@/pages/workspace/canvasFile";

export type JuggleWorkProjectState = {
  projects: Project[];
  currentDirectory: string | null;
};

export type JuggleWorkProjectOpenResult = JuggleWorkProjectState & {
  mode: "created" | "imported";
};

type JuggleWorkHostBridge = {
  getProjectState(): JuggleWorkProjectState;
  showHome(): Promise<JuggleWorkProjectState>;
  chooseProject(): Promise<JuggleWorkProjectOpenResult | null>;
  openProject(directory: string): Promise<JuggleWorkProjectOpenResult>;
  renameProject(directory: string, name: string): JuggleWorkProjectState;
  removeProject(directory: string): Promise<JuggleWorkProjectState>;
};

declare global {
  interface Window {
    __TOONFLOW_JUGGLEWORK_HOST__?: JuggleWorkHostBridge;
  }
}

function snapshot(): JuggleWorkProjectState {
  const workspace = useWorkspaceStore();
  return {
    projects: workspace.projectList.map(project => ({ ...project })),
    currentDirectory: workspace.project?.directory ?? null,
  };
}

async function ensureCanvas(directory: string) {
  const files = useWorkspaceFiles(directory);
  const listing = await files.list();
  const jsonEntries = listing.entries.filter(entry => entry.type === "file" && entry.name.toLocaleLowerCase().endsWith(".json"));
  for (const entry of jsonEntries) {
    if (await isCanvasFile(files, entry.path)) return "imported" as const;
  }

  const names = new Set(listing.entries.map(entry => entry.name.toLocaleLowerCase()));
  let index = 1;
  while (names.has(`画布${index}.json`.toLocaleLowerCase())) index++;
  await files.writeJson(`画布${index}.json`, {
    toonflowCanvas: true,
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  }, true);
  return "created" as const;
}

async function selectDirectory() {
  const { data } = await axios.post<{ data: { directory: string | null } }>("/api/desktop/selectDirectory", null, {
    headers: { "x-toonflow-desktop": "1" },
  });
  return data.data.directory;
}

async function openProject(router: Router, directory: string) {
  const mode = await ensureCanvas(directory);
  const workspace = useWorkspaceStore();
  await workspace.openProject(directory, directory, undefined, flushWorkspaceSave);
  const checkedDirectory = workspace.project?.directory;
  if (!checkedDirectory) throw new Error("工作目录打开失败");
  await router.push("/workspace");
  await nextTick();
  await waitForWorkspaceReady(checkedDirectory);
  if (workspace.project?.directory !== checkedDirectory) throw new Error("工作区打开已取消");
  return { ...snapshot(), mode };
}

/** Exposes the minimum project API needed by JuggleWork's host sidebar. */
export function registerJuggleWorkHostBridge(router: Router) {
  const bridge: JuggleWorkHostBridge = {
    getProjectState: snapshot,
    async showHome() {
      await flushWorkspaceSave();
      useWorkspaceStore().closeProject();
      await router.replace("/home");
      await nextTick();
      return snapshot();
    },
    async chooseProject() {
      const directory = await selectDirectory();
      return directory ? openProject(router, directory) : null;
    },
    openProject: directory => openProject(router, directory),
    renameProject(directory, name) {
      useWorkspaceStore().renameProject(directory, name);
      return snapshot();
    },
    async removeProject(directory) {
      const workspace = useWorkspaceStore();
      if (workspace.project?.directory === directory) {
        const failure = await router.push("/home");
        if (failure) throw new Error("当前项目尚未退出，无法移除");
      }
      workspace.removeProject(directory);
      await nextTick();
      return snapshot();
    },
  };
  window.__TOONFLOW_JUGGLEWORK_HOST__ = bridge;
  return () => {
    if (window.__TOONFLOW_JUGGLEWORK_HOST__ === bridge) delete window.__TOONFLOW_JUGGLEWORK_HOST__;
  };
}
