import { defineStore } from "pinia";
import { ref } from "vue";
import axios from "axios";

export type Project = {
  directory: string;
  name: string;
  lastOpenedAt: number;
};

export const useWorkspaceStore = defineStore("workspace", () => {
  const project = ref<Project | null>(null);
  const projectList = ref<Project[]>([]);
  const pendingAgentMessage = ref<{ directory: string; prompt: string; model: string; reasoningEffort: string } | null>(null);

  async function openProject(path: string, previousDirectory = path, signal?: AbortSignal, beforeCommit?: () => Promise<void>) {
    const { data } = await axios.get<{ code: number; data?: { directory: string }; message?: string }>("/api/workspaces/check", {
      params: { directory: path }, headers: { "x-toonflow-workspace": "1" }, signal,
    });
    signal?.throwIfAborted();
    if (data.code !== 200 || !data.data?.directory) throw new Error(data.message || "工作目录校验失败");
    const checkedDirectory = data.data.directory;
    await beforeCommit?.();
    signal?.throwIfAborted();
    pendingAgentMessage.value = null;
    const previousProjects = projectList.value;
    const existingIndex = previousProjects.findIndex(item => item.directory === previousDirectory);
    const checkedIndex = previousProjects.findIndex(item => item.directory === checkedDirectory);
    const targetIndex = existingIndex >= 0 ? existingIndex : checkedIndex;
    const existing = targetIndex >= 0 ? previousProjects[targetIndex] : undefined;
    project.value = {
      directory: checkedDirectory,
      name: existing?.name || checkedDirectory.split(/[\\/]/).filter(Boolean).at(-1) || checkedDirectory,
      lastOpenedAt: existing?.lastOpenedAt ?? Date.now(),
    };
    if (targetIndex < 0) projectList.value = [project.value, ...previousProjects];
    else {
      const insertionIndex = previousProjects.slice(0, targetIndex)
        .filter(item => item.directory !== previousDirectory && item.directory !== checkedDirectory).length;
      const nextProjects = previousProjects.filter(item => item.directory !== previousDirectory && item.directory !== checkedDirectory);
      nextProjects.splice(insertionIndex, 0, project.value);
      projectList.value = nextProjects;
    }
  }

  function renameProject(path: string, name: string) {
    const target = projectList.value.find(item => item.directory === path);
    if (!target || !name.trim()) return;
    target.name = name.trim();
    if (project.value?.directory === path) project.value = target;
  }

  function removeProject(path: string) {
    projectList.value = projectList.value.filter(item => item.directory !== path);
    if (project.value?.directory === path) project.value = null;
  }

  function closeProject() {
    pendingAgentMessage.value = null;
    project.value = null;
  }

  return { project, projectList, pendingAgentMessage, openProject, renameProject, removeProject, closeProject };
}, {
  persist: {
    key: "toonflow.projectList",
    pick: ["project", "projectList"],
  },
});
