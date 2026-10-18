<template>
  <mini-map
    v-if="showMap"
    position="bottom-left"
    :style="{ bottom: `${controlsHeight + 30}px` }"
    :pannable="true"
    :zoomable="true"
    node-color="var(--el-fill-color-dark)"
    mask-color="var(--el-mask-color-extra-light)" />
  <panel
    class="canvasControlsPanel"
    position="bottom-left"
    :style="{
      width: 'calc(100% - 30px)',
      margin: '15px',
      containerType: 'inline-size',
      containerName: 'canvasControls',
    }">
    <div ref="controlsLayout" class="canvasControlLayout">
      <div class="canvasSecondaryControl">
        <el-card class="canvasSecondaryCard" shadow="never" :bodyStyle="{ padding: '3px' }">
        <div class="canvasControls">
        <el-tooltip :showArrow="false" :content="assetsVisible ? '关闭素材库' : '打开素材库'" placement="top" :hideAfter="0" :enterable="false" :triggerKeys="[]">
          <el-button
            class="toolButton"
            text
            :type="assetsVisible ? 'primary' : 'default'"
            :aria-pressed="assetsVisible"
            aria-label="素材库"
            @click="assetsVisible = !assetsVisible">
            <icon-folders :size="14" />
          </el-button>
        </el-tooltip>
        <!-- trigger 用 contextmenu 是为了让整理按钮只由 arrangeNodes 控制显隐，同时仍保留点击外部自动关闭 -->
        <el-tooltip :showArrow="false" content="整理画布" placement="top" :hideAfter="0" :enterable="false" :triggerKeys="[]" :disabled="undoPopoverVisible">
          <span class="toolTrigger">
            <el-popover trigger="contextmenu" placement="top-start" :width="180" v-model:visible="undoPopoverVisible">
              <template #reference>
                <el-button class="toolButton" text :disabled="!canArrange" aria-label="整理画布" @click="arrangeNodes">
                  <icon-sitemap :size="14" />
                </el-button>
              </template>
              <div class="zoomMenu">
                <el-button class="zoomAction" style="width: 100%" text @click="undoArrange">撤销整理</el-button>
              </div>
            </el-popover>
          </span>
        </el-tooltip>
        <el-tooltip :showArrow="false" :content="showMap ? '隐藏地图' : '显示地图'" placement="top" :hideAfter="0" :enterable="false" :triggerKeys="[]">
          <el-button
            class="toolButton"
            text
            :type="showMap ? 'primary' : 'default'"
            :aria-pressed="showMap"
            aria-label="显示或隐藏地图"
            @click="showMap = !showMap">
            <icon-map :size="14" />
          </el-button>
        </el-tooltip>
        <el-tooltip :showArrow="false" :content="snapEnabled ? '关闭网格吸附' : '开启网格吸附'" placement="top" :hideAfter="0" :enterable="false" :triggerKeys="[]">
          <el-button
            class="toolButton"
            text
            :type="snapEnabled ? 'primary' : 'default'"
            :aria-pressed="snapEnabled"
            aria-label="网格吸附"
            @click="snapEnabled = !snapEnabled">
            <icon-magnet :size="14" />
          </el-button>
        </el-tooltip>
        <el-tooltip :showArrow="false" :content="showEdges ? '隐藏连线' : '显示连线'" placement="top" :hideAfter="0" :enterable="false" :triggerKeys="[]">
          <el-button
            class="toolButton"
            text
            :type="showEdges ? 'primary' : 'default'"
            :aria-pressed="showEdges"
            aria-label="显示或隐藏连线"
            @click="showEdges = !showEdges">
            <icon-arrow-guide :size="14" />
          </el-button>
        </el-tooltip>
        <el-tooltip :showArrow="false" content="适应视图" placement="top" :hideAfter="0" :enterable="false" :triggerKeys="[]">
          <el-button class="toolButton" text aria-label="适应视图" @click="fitView()">
            <icon-focus-centered :size="14" />
          </el-button>
        </el-tooltip>
        <el-tooltip :showArrow="false"
          content="缩放菜单（滚轮调整缩放）"
          placement="top"
          :hideAfter="0"
          :enterable="false"
          :triggerKeys="[]"
          :disabled="zoomMenuVisible">
          <span class="toolTrigger">
            <el-popover v-model:visible="zoomMenuVisible" trigger="click" placement="top-start" :width="216">
              <template #reference>
                <el-button
                  class="toolButton zoomButton"
                  text
                  aria-label="缩放菜单"
                  @wheel.stop.prevent="$event.deltaY && applyZoom(Math.min(800, Math.max(20, zoomPercent - Math.sign($event.deltaY))))">
                  {{ zoomPercent }}%
                </el-button>
              </template>
              <div class="zoomMenu">
                <el-input-number
                  class="zoomInput"
                  :model-value="zoomPercent"
                  :min="20"
                  :max="800"
                  :controls="false"
                  aria-label="缩放百分比"
                  @change="applyZoom">
                  <template #suffix>%</template>
                </el-input-number>
                <el-button class="zoomAction" text @click="zoomIn()">放大</el-button>
                <el-button class="zoomAction" text @click="zoomOut()">缩小</el-button>
                <el-button class="zoomAction" text @click="fitView()">适合屏幕</el-button>
              </div>
            </el-popover>
          </span>
        </el-tooltip>
        </div>
        </el-card>
      </div>
      <div class="canvasPrimaryControl">
        <el-card class="canvasPrimaryCard" shadow="never" :bodyStyle="{ padding: '3px' }">
        <div class="canvasPrimaryTools" role="toolbar" aria-label="画布工具">
        <el-tooltip :showArrow="false" content="添加节点" placement="top" :hideAfter="0" :enterable="false" :triggerKeys="[]">
          <el-button class="primaryToolButton addToolButton" aria-label="添加节点" @click="emit('addNode')">
            <icon-plus :size="16" strokeWidth="1.8" />
          </el-button>
        </el-tooltip>
        <el-tooltip :showArrow="false" :content="props.selectedTool === 'move' ? '移动工具，点击切换为抓手' : '抓手工具，点击切换为移动'" placement="top" :hideAfter="0" :enterable="false" :triggerKeys="[]">
          <el-button
            class="primaryToolButton"
            text
            :type="props.selectedTool === 'hand' ? 'primary' : 'default'"
            :aria-pressed="props.selectedTool === 'hand'"
            aria-label="切换抓手/移动工具"
            @click="emit('update:selectedTool', props.selectedTool === 'move' ? 'hand' : 'move')">
            <component :is="props.selectedTool === 'move' ? IconPointer : IconHandStop" :size="16" strokeWidth="1.8" aria-hidden="true" />
          </el-button>
        </el-tooltip>
        </div>
        </el-card>
      </div>
    </div>
  </panel>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Panel, useVueFlow, type XYPosition } from "@vue-flow/core";
import { MiniMap } from "@vue-flow/minimap";
import { IconMap, IconMagnet, IconFocusCentered, IconPlus, IconPointer, IconHandStop } from "@tabler/icons-vue";
import { ElMessage } from "element-plus";
import { arrangeCanvas } from "../arrangeCanvas";

const props = defineProps<{
  canvasId: string;
  directory: string | undefined;
  batchHistory: (action: () => Promise<void>) => Promise<void>;
  selectedTool: "move" | "hand";
}>();
const snapEnabled = defineModel<boolean>("snapEnabled", { required: true });
const showEdges = defineModel<boolean>("showEdges", { required: true });
const assetsVisible = defineModel<boolean>("assetsVisible", { default: false });
const emit = defineEmits<{ addNode: []; "update:selectedTool": [value: "move" | "hand"] }>();
const controlsLayout = ref<HTMLElement>();
const controlsHeight = ref(32);
let controlsResizeObserver: ResizeObserver | undefined;
const showMap = ref(false);
const zoomMenuVisible = ref(false);
const flow = useVueFlow();
const { viewport, zoomTo, zoomIn, zoomOut, fitView, getNodes, updateNode } = flow;
const zoomPercent = computed(() => Math.round(viewport.value.zoom * 100));
const layoutSnapshot = ref<{ id: string; position: XYPosition }[]>();
const undoPopoverVisible = ref(false);
const arranging = ref(false);
let arrangeController: AbortController | undefined;
const canArrange = computed(() => {
  const nodes = getNodes.value.filter((node) => !node.parentNode);
  return (
    !!props.canvasId &&
    !!props.directory &&
    !arranging.value &&
    nodes.length > 0 &&
    nodes.every((node) => node.dimensions.width > 0 && node.dimensions.height > 0)
  );
});
defineExpose({ arrangeNodes });

watch(
  () => [props.canvasId, props.directory],
  () => {
    arrangeController?.abort();
    layoutSnapshot.value = undefined;
    undoPopoverVisible.value = false;
  },
  { flush: "sync" }
);
onMounted(() => {
  controlsResizeObserver = new ResizeObserver(() => {
    const layout = controlsLayout.value;
    if (!layout) return;
    controlsHeight.value = Math.ceil(layout.getBoundingClientRect().height || 32);
  });
  if (controlsLayout.value) controlsResizeObserver.observe(controlsLayout.value);
});
onBeforeUnmount(() => {
  arrangeController?.abort();
  controlsResizeObserver?.disconnect();
});

function applyZoom(value: number | undefined) {
  if (value !== undefined && Number.isFinite(value)) void zoomTo(value / 100);
}

async function arrangeNodes() {
  if (!canArrange.value) return;
  const controller = new AbortController();
  arrangeController = controller;
  arranging.value = true;
  try {
    await props.batchHistory(async () => {
      const { snapshot, arrangedNodeIds } = await arrangeCanvas(flow, controller.signal);
      controller.signal.throwIfAborted();
      if (!arrangedNodeIds.length) return;
      layoutSnapshot.value = snapshot;
      undoPopoverVisible.value = true;
    });
  } catch (error) {
    if (!controller.signal.aborted) ElMessage.error(error instanceof Error ? error.message : "整理画布失败");
  } finally {
    arrangeController = undefined;
    arranging.value = false;
  }
}

async function undoArrange() {
  const snapshot = layoutSnapshot.value;
  if (!snapshot) return;
  try {
    await props.batchHistory(async () => {
      const nodeIds = new Set(getNodes.value.map((node) => node.id));
      snapshot.forEach(({ id, position }) => {
        if (nodeIds.has(id)) updateNode(id, { position });
      });
      layoutSnapshot.value = undefined;
      undoPopoverVisible.value = false;
    });
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "撤销整理失败");
  }
}
</script>

<style lang="scss" scoped>
.canvasControls {
  display: flex;
  align-items: center;
  gap: 4px;

  .toolTrigger {
    display: inline-flex;
  }

  .toolButton {
    width: 24px;
    height: 24px;
    font-size: 12px;
    flex-shrink: 0;
    margin-left: 0;
    padding: 0;
  }

  .zoomButton {
    width: 40px;
  }
}

.canvasControlLayout {
  position: relative;
  min-height: 32px;
  align-items: center;

  .canvasSecondaryControl {
    width: max-content;
  }

  .canvasPrimaryControl {
    position: absolute;
    bottom: 0;
    left: 50%;
    width: max-content;
    transform: translateX(-50%);
  }

  .canvasPrimaryCard {
    border-radius: 12px;
    background: color-mix(in srgb, var(--el-bg-color-overlay) 94%, transparent);
    box-shadow: var(--el-box-shadow-lighter);
    overflow: hidden;
  }

  .canvasPrimaryTools {
    display: flex;
    align-items: center;
    gap: 2px;

    .toolTrigger {
      display: inline-flex;
    }

    .primaryToolButton {
      width: 24px;
      height: 24px;
      flex-shrink: 0;
      margin-left: 0;
      padding: 0;
      border: 0;
      border-radius: 7px;
      background: transparent;
      color: var(--el-text-color-secondary);
      cursor: pointer;
      transition: color 120ms ease, background-color 120ms ease, transform 120ms ease;

      &:hover,
      &:focus-visible {
        color: var(--el-text-color-primary);
        background: var(--el-fill-color);
      }

      &:active {
        transform: scale(0.94);
      }

      &.addToolButton {
        background: var(--el-text-color-primary);
        color: var(--el-bg-color);
      }
    }
  }

}

@container canvasControls (max-width: 753px) {
  .canvasControlLayout {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;

    .canvasPrimaryControl {
      position: static;
      order: -1;
      transform: none;
    }
  }
}

.zoomMenu {
  display: flex;
  flex-direction: column;

  .zoomInput {
    width: 100%;
  }

  .zoomAction {
    justify-content: flex-start;
    margin-left: 0;
  }
}

</style>
