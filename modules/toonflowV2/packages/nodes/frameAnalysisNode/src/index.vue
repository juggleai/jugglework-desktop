<template>
  <nodeSkeleton v-bind="nodeProps" :style="{ width: '360px' }">
    <div class="analysisPanel nodrag nopan nowheel" @pointerdown.stop @keydown.stop>
      <p>{{ source ? '已连接视频，可开始本地镜头分析' : '请连接一个视频输出到输入端口' }}</p>
      <label>场景差异阈值<el-input-number v-model="data.threshold" :min="0.05" :max="0.9" :step="0.05" :disabled="busy" /></label>
      <label>最短镜头（秒）<el-input-number v-model="data.minSceneSeconds" :min="0.1" :max="30" :step="0.1" :disabled="busy" /></label>
      <p>逐帧检测，输出镜头视频、关键帧和原音轨。限10分钟、120镜头。</p>
      <p v-if="busy" role="status">正在分析和导出，请等待…</p>
      <p v-else-if="data.result">{{ data.result.scenes.length }} 个镜头 · {{ data.result.duration.toFixed(2) }} 秒</p>
      <el-button v-if="busy" @click="controller?.abort()">取消处理</el-button>
      <el-button v-else type="primary" :disabled="!source" @click="start">{{ data.result ? '重新分析' : '开始拉片' }}</el-button>
      <el-button :disabled="busy || !data.result" @click="rebuild">重建结果节点</el-button>
    </div>
  </nodeSkeleton>
</template>

<script setup lang="ts">
// Adapted from Toonflow v2.0.8 frameAnalysisNode (MIT, Copyright (c) 2026 HBAI-Ltd).
import { computed, inject, onBeforeUnmount, ref, watch } from "vue";
import { useVueFlow, type Node } from "@vue-flow/core";
import { ElButton, ElInputNumber, ElMessage } from "element-plus";
import { IconMovie } from "@tabler/icons-vue";
import { nodeSkeleton, useNode, useNodeInputs, type NodeHandle } from "@toonflow/nodes-scaffold/runtime";
import { createOutputDirectory, useMediaProcessing, type MediaResult } from "@toonflow/node-video/videoProcessing";

defineOptions({ inheritAttrs: false, icon: IconMovie, handles: [{ id: "in", type: "target", dataType: "VIDEO", label: "视频输入" }] satisfies NodeHandle[] });
const { node, nodeProps, nodeEvent, files } = useNode({ label: "逐帧拉片" });
const { getTargetValues } = useNodeInputs();
const { addNodes, findNode, getNodes, nodeTypes } = useVueFlow();
const data = computed(() => node.data as { threshold: number; minSceneSeconds: number; result?: MediaResult });
data.value.threshold ??= 0.3;
data.value.minSceneSeconds ??= 0.5;
const source = computed(() => {
  const inputs = getTargetValues(node.id, "in");
  return inputs.length === 1 && inputs[0]?.dataType === "VIDEO" ? inputs[0].value : undefined;
});
const processMedia = useMediaProcessing();
const canvas = inject<() => { id: string } | undefined>("canvas", () => undefined);
const batch = inject<(action: () => Promise<void>) => Promise<void>>("batchCanvasHistory", action => action());
const busy = ref(false);
let controller: AbortController | undefined;
let job: Promise<void> | undefined;
const cancel = () => controller?.abort();
watch(() => source.value?.url, cancel, { flush: "sync" });
watch(() => canvas()?.id, cancel, { flush: "sync" });
onBeforeUnmount(cancel);
nodeEvent.on("delete", async () => { cancel(); await job; });
nodeEvent.on("save", reason => { if (reason === "reload" && busy.value) throw new Error("请完成或取消拉片后再刷新"); });
const showError = (error: unknown) => ElMessage.error(error instanceof Error ? error.message : "拉片失败");

function createResults(result: MediaResult) {
  if (findNode(node.id) !== node) throw new Error("拉片节点已变化");
  const media = result.scenes.flatMap(scene => [
    { path: scene.video, kind: "video", label: `镜头 ${scene.index} · ${scene.start.toFixed(2)}–${scene.end.toFixed(2)} 秒`, mime: "video/mp4" },
    { path: scene.image, kind: "image", label: `关键帧 ${scene.index}`, mime: "image/jpeg" },
  ]);
  if (result.audio) media.push({ path: result.audio, kind: "audio", label: "原音轨", mime: "audio/mp4" });
  if (media.some(item => !nodeTypes?.value?.[`remote-${item.kind}Node`])) throw new Error("视频、图片或音频节点尚未加载");
  // Rebuild missing nodes only, preserving user edits and undo references to existing results.
  const existing = new Set(getNodes.value.filter(item => item.data.frameAnalysisOwner === node.id).map(item => item.data.frameAnalysisPath));
  const nodes: Node[] = media.filter(item => !existing.has(item.path)).map((item, index) => ({
    id: crypto.randomUUID(), type: `remote-${item.kind}Node`,
    position: { x: node.computedPosition.x + 440 + index % 2 * 480, y: node.computedPosition.y + Math.floor(index / 2) * 340 },
    data: { label: item.label, frameAnalysisOwner: node.id, frameAnalysisPath: item.path,
      outputs: { [item.kind]: { dataType: item.kind.toUpperCase(), value: { url: item.path, mimeType: item.mime } } } },
  }));
  addNodes(nodes);
}

function start() {
  if (busy.value || !source.value) return;
  const path = source.value.url, canvasId = canvas()?.id;
  const threshold = data.value.threshold, minSceneSeconds = data.value.minSceneSeconds;
  const workspace = files.getWorkspaceFiles();
  const current = controller = new AbortController();
  busy.value = true;
  job = (async () => {
    try {
      const { directory } = await workspace.list();
      current.signal.throwIfAborted();
      const outputDirectory = await createOutputDirectory(workspace);
      current.signal.throwIfAborted();
      const result = await processMedia({ operation: "analyze", directory, path, outputDirectory, threshold, minSceneSeconds }, current.signal);
      current.signal.throwIfAborted();
      if (canvas()?.id !== canvasId || findNode(node.id) !== node || source.value?.url !== path) throw new Error("画布或视频已变化，清单保留在项目产物目录");
      await batch(async () => {
        current.signal.throwIfAborted();
        data.value.result = result;
        createResults(result);
      });
      ElMessage.success(`拉片完成：${result.scenes.length} 个镜头`);
    } catch (error) { if (!current.signal.aborted) showError(error); }
    finally { busy.value = false; controller = undefined; }
  })();
}

async function rebuild() {
  if (busy.value || !data.value.result) return;
  busy.value = true;
  const result = data.value.result, canvasId = canvas()?.id;
  const workspace = files.getWorkspaceFiles();
  try {
    // Check saved artifacts before recreating references. Missing media requires a fresh analysis.
    const directory = result.manifest.slice(0, result.manifest.lastIndexOf("/"));
    const { entries } = await workspace.list(directory);
    const paths = new Set(entries.filter(entry => entry.type === "file").map(entry => entry.path));
    if ([...result.scenes.flatMap(scene => [scene.video, scene.image]), ...(result.audio ? [result.audio] : [])].some(path => !paths.has(path))) throw new Error("部分产物已删除，请重新分析");
    if (canvas()?.id !== canvasId) throw new Error("画布已变化");
    await batch(async () => createResults(result));
  } catch (error) { showError(error); }
  finally { busy.value = false; }
}
</script>

<style scoped>
.analysisPanel { padding: 12px; }
.analysisPanel label { display: flex; align-items: center; justify-content: space-between; margin: 12px 0; }
.analysisPanel p { font-size: 12px; color: var(--el-text-color-secondary); }
</style>
