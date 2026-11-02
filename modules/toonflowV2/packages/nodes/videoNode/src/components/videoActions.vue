<template>
  <el-dialog v-model="visible" :title="labels[action]" width="640px" appendToBody :closeOnClickModal="!busy" :closeOnPressEscape="!busy" :showClose="!busy">
    <div class="videoActionPanel nodrag nopan nowheel" @pointerdown.stop @keydown.stop>
      <template v-if="action === 'trim'">
        <video :src="src" controls preload="metadata" style="width:100%;max-height:320px" />
        <p>源视频 {{ duration.toFixed(2) }} 秒；输入保留片段的起止时间。</p>
        <label>开始（秒）<el-input-number v-model="start" :min="0" :max="duration" :step="0.1" :disabled="busy" /></label>
        <label>结束（秒）<el-input-number v-model="end" :min="0" :max="duration" :step="0.1" :disabled="busy" /></label>
      </template>
      <p>处理完成后创建{{ action === 'extractAudio' ? '音轨' : action === 'separate' ? '静音视频和音轨' : '视频' }}节点，保留原素材。</p>
      <p v-if="busy" role="status">正在处理；取消将终止本地进程。</p>
      <el-button @click="busy ? controller?.abort() : visible = false">{{ busy ? '取消处理' : '关闭' }}</el-button>
      <el-button type="primary" :disabled="busy || disabled || !file || (action === 'trim' && !(end > start && end <= duration))" @click="run">{{ labels[action] }}</el-button>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
// Adapted from Toonflow v2.0.8 videoActions.vue (MIT, Copyright (c) 2026 HBAI-Ltd).
import { inject, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useNode, useVueFlow, type Node } from "@vue-flow/core";
import { ElButton, ElDialog, ElInputNumber, ElMessage } from "element-plus";
import { useNodeFiles, useNodeEvent, type NodeMediaValue } from "@toonflow/nodes-scaffold/runtime";
import { createOutputDirectory, useMediaProcessing } from "../videoProcessing";

const props = defineProps<{ file?: NodeMediaValue; src: string; disabled?: boolean }>();
const { node } = useNode();
const { addNodes, addEdges, findNode, removeNodes, nodeTypes } = useVueFlow();
const files = useNodeFiles();
const processMedia = useMediaProcessing();
const events = useNodeEvent();
const canvas = inject<() => { id: string } | undefined>("canvas", () => undefined);
const batch = inject<(action: () => Promise<void>) => Promise<void>>("batchCanvasHistory", action => action());
const labels = { extractAudio: "提取音轨", separate: "分离音视频", trim: "截取片段" };
const action = ref<keyof typeof labels>("trim");
const visible = ref(false), busy = ref(false), duration = ref(0), start = ref(0), end = ref(0);
let controller: AbortController | undefined;
let job: Promise<void> | undefined;
const cancel = () => controller?.abort();
const reset = () => { cancel(); visible.value = false; duration.value = end.value = start.value = 0; };
watch(() => props.file?.url, reset, { flush: "sync" });
watch(() => props.disabled, value => { if (value) reset(); }, { flush: "sync" });
watch(() => canvas()?.id, reset, { flush: "sync" });
onBeforeUnmount(cancel);
events.on("delete", async () => { cancel(); await job; });
events.on("save", reason => { if (reason === "reload" && busy.value) throw new Error("请完成或取消视频处理后再刷新"); });
const showError = (error: unknown) => ElMessage.error(error instanceof Error ? error.message : "视频处理失败");
defineExpose({ open, createAnalysis, busy });

async function open(value: keyof typeof labels) {
  if (busy.value || props.disabled || !props.file) return;
  action.value = value;
  visible.value = true;
  if (value !== "trim") return;
  busy.value = true;
  const current = controller = new AbortController();
  duration.value = end.value = start.value = 0;
  job = (async () => {
    try {
      const workspace = files.getWorkspaceFiles();
      const source = props.file!.url;
      const { directory } = await workspace.list();
      current.signal.throwIfAborted();
      const info = await processMedia({ operation: "probe", directory, path: source }, current.signal);
      current.signal.throwIfAborted();
      duration.value = end.value = info.duration;
    } catch (error) { if (!current.signal.aborted) showError(error); }
    finally { busy.value = false; controller = undefined; }
  })();
  await job;
}

async function createAnalysis() {
  if (busy.value || props.disabled || !props.file) return;
  const type = "remote-frameAnalysisNode", id = crypto.randomUUID(), canvasId = canvas()?.id;
  busy.value = true;
  try {
    if (!nodeTypes?.value?.[type]) throw new Error("逐帧拉片节点未加载，请重新打开画布");
    await batch(async () => {
      addNodes({ id, type, position: { x: node.computedPosition.x + (node.dimensions.width || 320) + 80, y: node.computedPosition.y }, data: { label: "逐帧拉片" } });
      await nextTick();
      if (canvas()?.id !== canvasId || findNode(node.id) !== node) throw new Error("画布已变化");
      addEdges({ id: crypto.randomUUID(), source: node.id, sourceHandle: "video", target: id, targetHandle: "in" });
    });
  } catch (error) { removeNodes(id, true, false); showError(error); }
  finally { busy.value = false; }
}

function run() {
  if (busy.value || props.disabled || !props.file) return;
  if (action.value === "trim" && (!Number.isFinite(start.value) || !Number.isFinite(end.value) || start.value < 0 || end.value <= start.value || end.value > duration.value)) return;
  const operation = action.value, source = props.file.url, canvasId = canvas()?.id;
  const clipStart = start.value, clipEnd = end.value;
  const workspace = files.getWorkspaceFiles();
  const current = controller = new AbortController();
  busy.value = true;
  job = (async () => {
    try {
      const required = operation === "extractAudio" ? ["audio"] : operation === "separate" ? ["video", "audio"] : ["video"];
      if (required.some(kind => !nodeTypes?.value?.[`remote-${kind}Node`])) throw new Error("结果节点插件未加载");
      const { directory } = await workspace.list();
      current.signal.throwIfAborted();
      const outputDirectory = await createOutputDirectory(workspace);
      current.signal.throwIfAborted();
      const result = await processMedia(operation === "trim"
        ? { operation, directory, path: source, outputDirectory, start: clipStart, end: clipEnd }
        : { operation, directory, path: source, outputDirectory }, current.signal);
      current.signal.throwIfAborted();
      if (canvas()?.id !== canvasId || findNode(node.id) !== node || props.file?.url !== source) throw new Error("画布或视频已变化，产物已保留在项目中");
      const nodes: Node[] = required.map((kind, index) => ({
        id: crypto.randomUUID(), type: `remote-${kind}Node`,
        position: { x: node.computedPosition.x + (node.dimensions.width || 320) + 80, y: node.computedPosition.y + index * 320 },
        data: { label: `${node.data.label || "视频"} · ${kind === "audio" ? "音轨" : labels[operation]}`, outputs: { [kind]: { dataType: kind.toUpperCase(), value: { url: kind === "audio" ? result.audio : result.video, mimeType: `${kind}/mp4` } } } },
      }));
      await batch(async () => { current.signal.throwIfAborted(); addNodes(nodes); });
      visible.value = false;
      ElMessage.success("处理完成，已创建结果节点");
    } catch (error) { if (!current.signal.aborted) showError(error); }
    finally { busy.value = false; controller = undefined; }
  })();
}
</script>

<style scoped>
.videoActionPanel label { display: inline-flex; gap: 8px; margin: 8px; align-items: center; }
</style>
