// Restricted adaptation of Toonflow v2.0.8 videoProcessing.ts (MIT, Copyright (c) 2026 HBAI-Ltd).
// Unlike the upstream fluent API, model input cannot supply executable arguments or filter expressions.
import { spawn } from "node:child_process";
import { lstat, realpath, mkdtemp, rm, link, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { verifyMediaTools, mediaRun } from "./mediaTools.mjs";

function object(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error("无效的剪辑参数");
}
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function projectPath(root, value, output = false) {
  if (typeof value !== "string" || !value || value.length > 4096 || path.isAbsolute(value) || /[\\:\x00-\x1f]/.test(value)) throw new Error("必须使用项目内相对文件路径");
  const parts = value.split("/");
  if (parts.some(part => !part || part === "." || part === "..")) throw new Error("不允许路径穿越");
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    if (output && index === parts.length - 1) break;
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error("不允许符号链接媒体路径");
    if (index < parts.length - 1 && !info.isDirectory()) throw new Error("媒体父路径不是目录");
  }
  const parent = await realpath(path.dirname(current));
  if (!inside(root, parent)) throw new Error("媒体路径超出授权项目");
  if (!output && !(await stat(current)).isFile()) throw new Error("媒体输入必须是普通文件");
  return current;
}
/** @param {{isDirectoryGranted: (directory: string) => boolean, mediaToolsRoot: string, mediaTarget?: {platform: string, arch: string}, packaged?: boolean}} options */
export function createToonFactoryVideoEditor({ isDirectoryGranted, mediaToolsRoot, mediaTarget = process, packaged = false }) {
  let active;
  async function execute(input, signal) {
    if (active) throw new Error("已有剪辑或探测任务运行中，请等待完成");
    const controller = new AbortController();
    const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(20 * 60 * 1000), ...(signal ? [signal] : [])]);
    let finish = () => {};
    const done = new Promise(resolve => { finish = () => resolve(undefined); });
    active = { controller, done };
    let temporary;
    const run = (executable, args) => new Promise((resolve, reject) => {
      combined.throwIfAborted();
      const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { PATH: "", LANG: "C", LC_ALL: "C" } });
      let stdout = "", stderr = "", failure;
      const abort = () => { failure = combined.reason; child.kill("SIGKILL"); };
      combined.addEventListener("abort", abort, { once: true });
      if (combined.aborted) abort();
      child.stdout.on("data", chunk => {
        stdout += chunk.toString();
        if (stdout.length > 1024 * 1024) { failure = new Error("媒体输出信息超出限制"); child.kill("SIGKILL"); }
      });
      child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
      child.on("error", error => { failure = error; });
      child.on("close", code => {
        combined.removeEventListener("abort", abort);
        if (failure) reject(failure);
        else if (code !== 0) reject(new Error(`媒体处理失败 (${code})：${stderr}`));
        else resolve(stdout);
      });
    });
    try {
      const operations = {
        probe: ["path"], export: ["clips", "output", "width", "height", "fps"],
        extractAudio: ["path", "outputDirectory"], separate: ["path", "outputDirectory"],
        trim: ["path", "outputDirectory", "start", "end"], analyze: ["path", "outputDirectory", "threshold", "minSceneSeconds"],
      };
      object(input, ["operation", "directory", ...(operations[input?.operation] ?? [])]);
      if (!Object.hasOwn(operations, input.operation) || typeof input.directory !== "string" || !path.isAbsolute(input.directory)) throw new Error("无效的媒体操作或目录");
      const root = await realpath(input.directory);
      if (!isDirectoryGranted(root)) throw new Error("项目目录未经 JuggleWork 授权");
      // The outer signed app seals the manifest; its mutable local build hashes
      // alone are not an upstream trust anchor. Development uses verified staging.
      if (packaged && mediaTarget.platform === "darwin") mediaRun("/usr/bin/codesign", ["--verify", "--strict", "-R", 'anchor apple generic and certificate leaf[subject.OU] = "H7PDHSK3C7" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists', path.resolve(mediaToolsRoot, "../../..")]);
      const tools = verifyMediaTools(mediaToolsRoot, mediaTarget, packaged ? { phase: "signed", team: "H7PDHSK3C7" } : { phase: "built" });
      const probe = async file => {
        const data = JSON.parse(await run(tools.ffprobe, ["-v", "error", "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm", "-show_entries", "format=duration:stream=codec_type,width,height,codec_name", "-of", "json", file]));
        const video = data.streams?.find(stream => stream.codec_type === "video");
        const duration = Number(data.format?.duration);
        if (!video || !Number.isFinite(duration) || duration <= 0 || duration > 1800) throw new Error("仅支持时长不超过30分钟的有效视频");
        if (![video.width, video.height].every(value => Number.isInteger(value) && value > 0 && value <= 4096)) throw new Error("视频边长不得超过4096像素");
        return { duration, width: video.width, height: video.height, hasAudio: data.streams.some(stream => stream.codec_type === "audio") };
      };
      const inputPath = async value => {
        if (typeof value !== "string" || !/\.(mp4|mov|mkv|webm)$/i.test(value)) throw new Error("仅支持项目内 MP4、MOV、MKV 或 WebM 视频");
        const file = await projectPath(root, value);
        if ((await stat(file)).size > 1024 * 1024 * 1024) throw new Error("输入视频不得超过1GB");
        return file;
      };
      if (input.operation === "probe") return { path: input.path, ...await probe(await inputPath(input.path)) };
      if (input.operation !== "export") {
        const file = await inputPath(input.path), info = await probe(file);
        const operation = input.operation;
        if (typeof input.outputDirectory !== "string") throw new Error("缺少新的产物目录");
        // The caller creates a fresh project directory; all filenames and filters are host-owned.
        const outputPath = name => `${input.outputDirectory}/${name}`;
        await projectPath(root, outputPath("manifest.json"), true);
        if (["extractAudio", "separate"].includes(operation) && !info.hasAudio) throw new Error("该视频没有音轨");
        if (operation === "trim" && (!Number.isFinite(input.start) || !Number.isFinite(input.end) || input.start < 0 || input.end <= input.start || input.end > info.duration)) throw new Error("截取范围须满足 0 ≤ 开始 < 结束 ≤ 视频时长");
        const threshold = input.threshold ?? 0.3, minSceneSeconds = input.minSceneSeconds ?? 0.5;
        if (operation === "analyze" && (info.duration > 600 || !Number.isFinite(threshold) || threshold < 0.05 || threshold > 0.9 || !Number.isFinite(minSceneSeconds) || minSceneSeconds < 0.1 || minSceneSeconds > 30)) throw new Error("拉片限10分钟；阈值0.05–0.9，最短镜头0.1–30秒");
        temporary = await mkdtemp(path.join(root, ".videoEdit-"));
        const common = ["-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-filter_threads", "2"];
        const source = ["-threads", "2", "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm", "-i", file];
        const pending = [];
        let bytes = 0;
        const render = async (name, args, seek) => {
          const target = path.join(temporary, name);
          await run(tools.ffmpeg, [...common, ...(seek === undefined ? [] : ["-ss", String(seek)]), ...source, ...args, "-fs", String(512 * 1024 * 1024), target]);
          const size = (await stat(target)).size;
          bytes += size;
          if (!size || size >= 512 * 1024 * 1024 || bytes > 2 * 1024 * 1024 * 1024) throw new Error("产物超出限制（单文件512MB，总计2GB）");
          if (name.endsWith(".mp4")) {
            const actual = await probe(target);
            const durationIndex = args.indexOf("-t");
            const expected = durationIndex < 0 ? info.duration : Number(args[durationIndex + 1]);
            if (Math.abs(actual.duration - expected) > 0.5 || (args.includes("-an") && actual.hasAudio)) throw new Error("视频产物校验失败");
          } else if (name.endsWith(".m4a")) {
            const actual = JSON.parse(await run(tools.ffprobe, ["-v", "error", "-protocol_whitelist", "file,pipe", "-show_entries", "format=duration:stream=codec_type", "-of", "json", target]));
            if (!actual.streams?.some(stream => stream.codec_type === "audio") || !Number.isFinite(Number(actual.format?.duration)) || Math.abs(Number(actual.format.duration) - info.duration) > 0.5) throw new Error("音轨产物校验失败");
          }
          pending.push(name);
          return outputPath(name);
        };
        const videoArgs = ["-map", "0:v:0", "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-c:v", "libx264", "-threads", "2", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart"];
        /** @type {Record<string, any>} */
        const result = { ...info, source: input.path, operation, manifest: outputPath("manifest.json"), scenes: [] };
        if (operation === "analyze") {
          // ACT: Fixed local scene-difference detector, not upstream adaptive/AI analysis.
          // Decode every frame at reduced resolution, keep at most 120 shots; never accept filter text.
          const metadata = await run(tools.ffmpeg, [...common, ...source, "-an", "-vf", `scale=160:90,select='gt(scene,${threshold})',metadata=print:file=-`, "-f", "null", "-"]);
          const boundaries = [0];
          for (const match of metadata.matchAll(/pts_time:([\d.]+)/g)) {
            const time = Number(match[1]);
            if (time - boundaries.at(-1) >= minSceneSeconds && info.duration - time >= minSceneSeconds) boundaries.push(time);
            if (boundaries.length > 120) throw new Error("检测超过120个镜头，请提高阈值或先截取片段");
          }
          boundaries.push(info.duration);
          for (let index = 0; index < boundaries.length - 1; index++) {
            const start = boundaries[index], end = boundaries[index + 1];
            const video = await render(`scene${index + 1}.mp4`, [...videoArgs, "-an", "-t", String(end - start)], start);
            const image = await render(`frame${index + 1}.jpg`, ["-map", "0:v:0", "-an", "-frames:v", "1", "-q:v", "2", "-threads", "2"], (start + end) / 2);
            result.scenes.push({ index: index + 1, start, end, video, image });
          }
          result.threshold = threshold;
          result.minSceneSeconds = minSceneSeconds;
        } else if (operation !== "extractAudio") {
          result.video = await render("video.mp4", [...videoArgs, ...(operation === "trim" ? ["-map", "0:a:0?", "-c:a", "aac", "-b:a", "192k", "-t", String(input.end - input.start)] : ["-an"])], operation === "trim" ? input.start : undefined);
          if (operation === "trim") result.duration = input.end - input.start;
        }
        if (info.hasAudio && operation !== "trim") result.audio = await render("audio.m4a", ["-map", "0:a:0", "-vn", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]);
        await writeFile(path.join(temporary, "manifest.json"), JSON.stringify(result, null, 2), { flag: "wx" });
        pending.push("manifest.json");
        const published = [];
        try {
          for (const name of pending) {
            combined.throwIfAborted();
            if (!isDirectoryGranted(root)) throw new Error("项目授权已变化");
            const target = await projectPath(root, outputPath(name), true);
            await link(path.join(temporary, name), target);
            published.push(target);
          }
          combined.throwIfAborted();
          return result;
        } catch (error) {
          await Promise.all(published.map(target => rm(target, { force: true })));
          throw error;
        }
      }
      if (!Array.isArray(input.clips) || input.clips.length < 1 || input.clips.length > 32) throw new Error("每次需要1至32个有序视频片段");
      const width = input.width ?? 1280, height = input.height ?? 720, fps = input.fps ?? 30;
      if (![width, height].every(value => Number.isInteger(value) && value >= 128 && value <= 3840 && value % 2 === 0) || ![24, 25, 30, 60].includes(fps)) throw new Error("分辨率须为128至3840之间的偶数，帧率须为24/25/30/60");
      if (typeof input.output !== "string" || !input.output.endsWith(".mp4")) throw new Error("输出必须是项目内新的 .mp4 文件，父目录须已存在");
      const output = await projectPath(root, input.output, true);
      try { await lstat(output); throw new Error("输出已存在，请选择新文件名；不会覆盖原文件"); } catch (error) { if (error.code !== "ENOENT") throw error; }
      const clips = [];
      let total = 0;
      for (const clip of input.clips) {
        object(clip, ["path", "start", "end"]);
        const file = await inputPath(clip.path), info = await probe(file);
        const start = clip.start ?? 0, end = clip.end ?? info.duration;
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > info.duration + 0.05) throw new Error("裁剪区间必须在源视频时长内，单位为秒");
        total += end - start;
        if (total > 1800) throw new Error("成片总时长不得超过30分钟");
        clips.push({ file, start, duration: end - start, hasAudio: info.hasAudio });
      }
      temporary = await mkdtemp(path.join(root, ".videoEdit-"));
      const common = ["-hide_banner", "-loglevel", "error", "-nostdin", "-n"];
      for (const [index, clip] of clips.entries()) {
        combined.throwIfAborted();
        const args = [...common, "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm", "-ss", String(clip.start), "-i", clip.file];
        if (!clip.hasAudio) args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
        args.push("-t", String(clip.duration), "-map", "0:v:0", "-map", clip.hasAudio ? "0:a:0" : "1:a:0", "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}`, "-af", `apad=whole_dur=${clip.duration},atrim=duration=${clip.duration},asetpts=PTS-STARTPTS`, "-c:v", "libx264", "-threads", "2", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", path.join(temporary, `${index}.mp4`));
        await run(tools.ffmpeg, args);
      }
      // The concat manifest contains only generated numeric filenames, never model-supplied paths.
      const manifest = path.join(temporary, "clips.txt");
      await writeFile(manifest, clips.map((_, index) => `file '${index}.mp4'`).join("\n"));
      const resultFile = path.join(temporary, "result.mp4");
      await run(tools.ffmpeg, [...common, "-protocol_whitelist", "file,pipe", "-f", "concat", "-safe", "1", "-i", manifest, "-c", "copy", "-movflags", "+faststart", resultFile]);
      const info = await probe(resultFile);
      if (Math.abs(info.duration - total) > Math.max(0.5, clips.length * 0.1)) throw new Error("导出时长校验失败，未发布成片");
      combined.throwIfAborted();
      if (!isDirectoryGranted(root) || await projectPath(root, input.output, true) !== output) throw new Error("导出授权或路径已变化");
      await link(resultFile, output);
      return { path: input.output, ...info, clips: clips.length, bytes: (await stat(output)).size };
    } finally {
      try { if (temporary) await rm(temporary, { recursive: true, force: true }); }
      finally { active = undefined; finish(); }
    }
  }
  return { execute, async stop() { const task = active; if (task) { task.controller.abort(new Error("剪辑已停止")); await task.done; } } };
}
