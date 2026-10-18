<template>
  <el-container class="home" :class="{ managedHome: juggleworkManaged }">
    <el-header v-if="!juggleworkManaged" class="pageHeader">
      <el-badge isDot :hidden="!hasDesktopUpdate">
        <el-button round size="large" :icon="IconSettings" :aria-label="hasDesktopUpdate ? '设置，有新版本可用' : '设置'" @click="settingsVisible = true">设置</el-button>
      </el-badge>
    </el-header>
    <el-main class="pageContent">
      <section class="introduction" aria-labelledby="homeTitle">
        <header class="introHeader">
          <img class="introLogo" :src="logoUrl" width="56" height="56" alt="" />
          <h1 id="homeTitle">漫剧工厂</h1>
          <p>与 AI 一起，把故事变成画面。<br />从剧本、角色到分镜与视频，在一个项目里完成创作。</p>
        </header>
        <div class="featureGrid">
          <article v-for="feature in features" :key="feature.title" class="featureCard">
            <span class="featureIcon"><component :is="feature.icon" :size="18" :strokeWidth="1.6" aria-hidden="true" /></span>
            <div class="featureContent">
              <h2>{{ feature.title }}</h2>
              <p>{{ feature.description }}</p>
            </div>
          </article>
        </div>
        <p v-if="juggleworkManaged" class="startHint">点击左侧 <strong>＋ 新建项目</strong>，开始你的第一部作品</p>
      </section>
      <section v-if="!juggleworkManaged" class="projectList" aria-labelledby="projectListTitle">
        <div class="sectionHeader">
          <h2 id="projectListTitle">项目列表</h2>
          <el-space wrap>
            <el-button :icon="iconFolderOpen" :disabled="creating || opening" @click="openProject()">导入项目</el-button>
            <el-button :icon="IconFolderPlus" :disabled="creating || opening" @click="createProject()">添加项目</el-button>
            <el-button circle :icon="sortDescending ? IconSortDescending : IconSortAscending" :aria-label="sortDescending ? '按时间降序' : '按时间升序'" @click="sortDescending = !sortDescending" />
            <el-radio-group v-model="viewMode" aria-label="项目视图">
              <el-radio-button value="grid" aria-label="网格视图"><icon-layout-grid :size="16" /></el-radio-button>
              <el-radio-button value="list" aria-label="列表视图"><icon-list :size="16" /></el-radio-button>
            </el-radio-group>
          </el-space>
        </div>
        <div class="projectItems" :class="{ listView: viewMode === 'list' }">
          <el-card v-for="project in sortedProjects" :key="project.directory" class="projectCard" shadow="hover" :bodyStyle="{ padding: '0' }">
            <button class="projectEntry" type="button" :disabled="creating || opening" :aria-label="`打开项目 ${project.name}`" @click="openProject(project)">
              <icon-folder class="projectIcon" :size="28" aria-hidden="true" />
              <span class="projectInfo">
                <span class="projectName" :title="project.name">{{ project.name }}</span>
                <span class="projectPath" :title="project.directory">{{ project.directory }}</span>
                <span class="projectTime">最近打开 {{ new Date(project.lastOpenedAt).toLocaleString('zh-CN', { hour12: false }) }}</span>
              </span>
            </button>
            <div class="projectActions">
              <el-button text :icon="IconEdit" :disabled="creating || opening" :aria-label="`重命名项目 ${project.name}`" title="重命名" @click="renameProject(project)" />
              <el-button text type="danger" :icon="IconTrash" :disabled="creating || opening" :aria-label="`移除项目 ${project.name}`" title="从列表移除，不删除文件" @click="workspaceStore.removeProject(project.directory)" />
            </div>
          </el-card>
        </div>
      </section>
    </el-main>
    <settings v-model="settingsVisible" />
    <workspacePicker ref="relocationPicker" hideTrigger />
  </el-container>
</template>

<script setup lang="ts">
import axios from "axios";
import { storeToRefs } from "pinia";
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  IconSettings,
  IconNotebook, IconUserSquare, IconPhoto, IconMovie, IconSchema, IconLayoutGrid,
  IconList, IconSortDescending,
  IconSortAscending, IconFolder, IconEdit,
  IconTrash, IconFolderPlus, IconFolderOpen as iconFolderOpen,
} from "@tabler/icons-vue";
import { useWorkspaceStore, type Project } from "@/stores/workspace";
import logoUrl from "@/assets/toon.png";
import { juggleworkManaged } from "@/stores/settings";
import { hasDesktopUpdate } from "@/stores/desktopUpdate";
import useWorkspaceFiles from "@/lib/workspaceFiles";
import settings from "@/components/settings/index.vue";
import workspacePicker from "./workspacePicker.vue";

const settingsVisible = ref(false);
const router = useRouter();
const creating = ref(false);
const opening = ref(false);
const relocationPicker = ref<InstanceType<typeof workspacePicker>>();
const workspaceStore = useWorkspaceStore();
const { projectList } = storeToRefs(workspaceStore);
const features = [
  { title: "故事与剧本", icon: IconNotebook, description: "从灵感或小说出发，梳理情节、人物与对白，写成可制作的剧本。" },
  { title: "角色设计", icon: IconUserSquare, description: "设定角色外形与服饰，生成参考图，为后续镜头提供统一依据。" },
  { title: "场景与道具", icon: IconPhoto, description: "构建故事里的环境和关键物件，积累可重复使用的视觉素材。" },
  { title: "分镜创作", icon: IconLayoutGrid, description: "把剧情拆成镜头，规划景别、构图与动作，让故事有清晰的画面节奏。" },
  { title: "视频与声音", icon: IconMovie, description: "让分镜变成动态片段，为故事生成旁白、音乐与声音素材。" },
  { title: "画布协作", icon: IconSchema, description: "在画布上组织文本与素材，与 AI 助手一起调整、生成和继续创作。" },
];
const sortDescending = ref(true);
const viewMode = ref("grid");
const sortedProjects = computed(() => [...projectList.value].sort((left, right) =>
  sortDescending.value ? right.lastOpenedAt - left.lastOpenedAt : left.lastOpenedAt - right.lastOpenedAt
));

async function openProject(project?: Project) {
  if (creating.value || opening.value) return;
  opening.value = true;
  try {
    const directory = project?.directory ?? await relocationPicker.value?.chooseDirectory();
    if (!directory) return;
    try { await workspaceStore.openProject(directory); }
    catch (err) {
      if (!project || !axios.isAxiosError<{ data?: { code?: string } }>(err)) throw err;
      const grantRequired = err.response?.status === 403 && err.response.data.data?.code === "DIRECTORY_GRANT_REQUIRED";
      if (err.response?.status !== 404 && !grantRequired) throw err;
      const reselect = await ElMessageBox.confirm(grantRequired
        ? `项目“${project.name}”需要重新授权，请再次选择原文件夹。`
        : `项目“${project.name}”的文件夹不存在，是否重新选择文件夹？`, grantRequired ? "工作目录授权已失效" : "工作目录不存在", {
        confirmButtonText: "重新选择", cancelButtonText: "取消", type: "warning",
      }).then(() => true, () => false);
      if (!reselect) return;
      const directory = await relocationPicker.value?.chooseDirectory();
      if (!directory) return;
      await workspaceStore.openProject(directory, project.directory);
    }
    await router.push("/workspace");
  } catch (err) {
    ElMessage.error(axios.isAxiosError<{ message?: string }>(err)
      ? err.response?.data.message || "无法打开项目，请重试"
      : err instanceof Error ? err.message : "无法打开项目，请重试");
  } finally { opening.value = false; }
}

async function renameProject(project: Project) {
  const result = await ElMessageBox.prompt("请输入项目名称", "重命名项目", {
    inputValue: project.name, confirmButtonText: "保存", cancelButtonText: "取消",
    inputValidator: value => !!value?.trim() || "项目名称不能为空",
  }).catch(() => null);
  if (result) workspaceStore.renameProject(project.directory, result.value);
}

async function createProject() {
  if (creating.value || opening.value) return;
  creating.value = true;
  try {
    const confirmed = await ElMessageBox.confirm("请选择一个空文件夹作为项目目录，画布和素材将保存在其中。", "添加项目", {
      confirmButtonText: "选择空文件夹", cancelButtonText: "取消", type: "info",
    }).then(() => true, () => false);
    if (!confirmed) return;
    const path = await relocationPicker.value?.chooseDirectory();
    if (!path) return;
    const { directory, empty } = await useWorkspaceFiles(path).list();
    if (!empty) return ElMessage.warning("该文件夹不为空，请重新选择空文件夹；已有项目请使用“导入项目”或点击项目列表打开。");
    await useWorkspaceFiles(directory).writeJson("画布1.json", { toonflowCanvas: true, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }, true);
    await workspaceStore.openProject(directory);
    await router.push("/workspace");
  } catch (err) {
    ElMessage.error(axios.isAxiosError<{ message?: string }>(err)
      ? err.response?.data.message || "创建项目失败，请重试"
      : err instanceof Error ? err.message : "创建项目失败，请重试");
  } finally {
    creating.value = false;
  }
}
</script>

<style lang="scss" scoped>
.home {
  min-height: 100dvh;
  color: var(--el-text-color-primary);
  background: var(--el-bg-color);

  &.managedHome .pageContent {
    display: flex;
    flex-direction: column;
    justify-content: center;
    min-height: 100dvh;
  }

  .pageHeader {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    height: 72px;
    padding: 0 36px;
  }

  .pageContent {
    padding: 66px 36px 76px;
    overflow: visible;

    .introduction {
      width: 100%;
      max-width: 760px;
      margin: 0 auto;

      .introHeader {
        margin-bottom: 36px;
        text-align: center;

        .introLogo {
          display: block;
          width: 56px;
          height: 56px;
          margin: 0 auto 16px;
          object-fit: contain;
        }

        h1 {
          margin: 0 0 12px;
          font-size: 22px;
          line-height: 1.4;
          font-weight: 600;
          letter-spacing: -0.4px;
        }

        p {
          max-width: 470px;
          margin: 0 auto;
          color: var(--el-text-color-regular);
          font-size: 13px;
          line-height: 1.9;
        }
      }

      .featureGrid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 14px;

        .featureCard {
          display: flex;
          align-items: flex-start;
          gap: 14px;
          min-height: 126px;
          padding: 22px 18px;
          border: 1px dashed var(--el-border-color);
          border-radius: 20px;

          .featureIcon {
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
            width: 34px;
            height: 34px;
            margin-top: 1px;
            border-radius: 10px;
            background: var(--el-fill-color-light);
          }

          .featureContent {
            min-width: 0;

            h2 {
              margin: 0 0 6px;
              font-size: 13px;
              line-height: 1.6;
              font-weight: 500;
            }

            p {
              margin: 0;
              color: var(--el-text-color-regular);
              font-size: 12px;
              line-height: 1.8;
              overflow-wrap: anywhere;
            }
          }
        }
      }

      .startHint {
        margin: 25px 0 0;
        text-align: center;
        color: var(--el-text-color-regular);
        font-size: 12px;
        line-height: 1.8;

        strong {
          color: var(--el-text-color-primary);
          font-weight: 500;
        }
      }
    }

    .projectList {
      max-width: 1040px;
      margin: 56px auto 0;

      .projectItems {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr));
        gap: 16px;
        margin-top: 16px;

        &.listView { grid-template-columns: 1fr; }

        .projectCard {
          position: relative;

          .projectActions {
            position: absolute;
            top: 12px;
            right: 8px;
            display: flex;
            gap: 4px;

            .el-button { width: 32px; height: 32px; margin: 0; padding: 0; }
          }
        }

        .projectEntry {
          display: flex;
          align-items: flex-start;
          gap: 12px;
          width: 100%;
          padding: 20px 84px 20px 20px;
          border: 0;
          background: transparent;
          color: inherit;
          font: inherit;
          text-align: left;
          cursor: pointer;

          &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: -2px; }
          &:disabled { cursor: wait; opacity: 0.6; }

          .projectIcon { flex-shrink: 0; color: var(--el-color-primary); }

          .projectInfo {
            display: flex;
            flex-direction: column;
            gap: 6px;
            min-width: 0;

            .projectName, .projectPath {
              overflow: hidden;
              text-overflow: ellipsis;
              white-space: nowrap;
            }

            .projectName { font-weight: 600; }
            .projectPath { font-size: 13px; color: var(--el-text-color-regular); }
            .projectTime { font-size: 12px; color: var(--el-text-color-secondary); }
          }
        }
      }

      .sectionHeader {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 16px;
        padding-bottom: 16px;
        border-bottom: 1px solid var(--el-border-color-lighter);

        h2 {
          margin: 0;
          font-size: 18px;
          font-weight: 600;
        }
      }
    }
  }
}

@media (max-width: 600px) {
  .home .pageContent {
    padding: 48px 20px;

    .introduction .featureGrid {
      grid-template-columns: 1fr;

      .featureCard {
        min-height: 0;
        padding: 20px;
      }
    }
  }
}
</style>
