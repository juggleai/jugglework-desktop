import { z } from "zod";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { hostFetch } from "@/utils/jugglework";

const path = z.string().min(1).max(4096).describe("已授权项目内的相对路径，不接受 URL 或绝对路径");
const probe = z.strictObject({ path });
const render = z.strictObject({
  clips: z.array(z.strictObject({ path, start: z.number().nonnegative().optional(), end: z.number().positive().optional() })).min(1).max(32),
  output: path.describe("新的 .mp4 相对文件名，父目录必须存在；不会覆盖已有文件"),
  width: z.number().int().min(128).max(3840).multipleOf(2).optional(),
  height: z.number().int().min(128).max(3840).multipleOf(2).optional(),
  fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(60)]).optional(),
});

export function createVideoEditTools(directory: string): ToolDefinition[] {
  return [
    { name: "probeVideo", label: "探测项目视频", schema: probe, operation: "probe", description: "探测项目内已有 MP4/MOV/MKV/WebM 的时长、宽高和音轨。剪辑前先探测，不生成新媒体。需要本机 FFmpeg/FFprobe。" },
    { name: "exportVideo", label: "剪辑并导出视频", schema: render, operation: "export", description: "按 clips 顺序裁剪并拼接已有视频，start/end 单位秒，省略即整段。输出新的 H.264/AAC MP4；默认1280×720、30fps，保持比例补黑边，缺音轨补静音。最多32段/总时长30分钟。先确认用户要求的顺序、裁剪和规格，不覆盖原素材。不支持字幕、转场或配乐编辑。等待返回后才报告完成，返回path可通过视频节点导入。取消会终止本地处理。" },
  ].map(({ name, label, schema, operation, description }) => ({
    name, label, description,
    parameters: z.toJSONSchema(schema, { io: "input", target: "draft-07" }) as ToolDefinition["parameters"],
    executionMode: "sequential",
    async execute(_id, params, signal) {
      const input = schema.parse(params);
      const result = await (await hostFetch("/videoEdit", { ...input, directory, operation }, signal)).json();
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  }));
}
