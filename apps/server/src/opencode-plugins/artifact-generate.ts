import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface GenerationInput {
  program: string;
  args: string[];
  outputs?: string[];
  timeoutMs?: number;
}
interface GenerationContext {
  abort?: AbortSignal;
  ask: (input: {
    permission: string;
    patterns: string[];
    always: string[];
    metadata: Record<string, unknown>;
  }) => Promise<void>;
}
interface GenerationHost {
  prepare: (
    outputs: string[],
  ) => Promise<{ generationId: string; outputDirectory: string }>;
  complete: (
    generationId: string,
    exitCode: number | null,
  ) => Promise<{ ok: boolean; files: unknown[]; targets?: unknown[] }>;
}

/**
 * 执行受控文件生成，使用引擎现有 bash 权限请求及取消信号。
 * @param input 可执行程序、参数和可选工作区输出路径，程序在专用交付目录运行
 * @param context 当前工具的真实权限上下文，缺少 ask 时拒绝执行
 * @param host 宿主的分配及完成接口；宿主自行枚举结果，不依赖 stdout
 */
export async function generateArtifactFiles(
  input: GenerationInput,
  context: GenerationContext,
  host: GenerationHost,
): Promise<unknown> {
  if (typeof context?.ask !== "function")
    throw new Error("当前引擎缺少执行权限上下文，无法生成文件");
  const command = [input.program, ...input.args].join(" ");
  await context.ask({
    permission: "bash",
    patterns: [command],
    always: [],
    metadata: { command, description: "生成交付文件" },
  });
  const allocation = await host.prepare(input.outputs ?? []);
  const temporary = await mkdtemp(join(tmpdir(), "jugglework-generation-"));
  let exitCode: number | null = null;
  let output = "";
  try {
    const signal = AbortSignal.any([
      ...(context.abort ? [context.abort] : []),
      AbortSignal.timeout(input.timeoutMs ?? 120_000),
    ]);
    exitCode = await new Promise<number | null>((resolve) => {
      // TIPS: 不拼接 Shell，参数原样传递；脚本和缓存应写独立临时目录，专用目录只存交付物。
      const child = spawn(input.program, input.args, {
        cwd: allocation.outputDirectory,
        signal,
        windowsHide: true,
        env: {
          ...process.env,
          JUGGLEWORK_ARTIFACT_DIR: allocation.outputDirectory,
          TMPDIR: temporary,
          TEMP: temporary,
          TMP: temporary,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const append = (chunk: Buffer) => {
        output = (output + chunk.toString("utf8")).slice(-64_000);
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      child.once("error", (error) => {
        output = `${output}\n${error.message}`;
      });
      child.once("close", resolve);
    });
  } catch (error) {
    output = `${output}\n${error instanceof Error ? error.message : "生成失败"}`;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  const delivery = await host.complete(allocation.generationId, exitCode);
  return {
    ok: exitCode === 0 && delivery.ok,
    generationId: allocation.generationId,
    exitCode,
    output,
    delivery,
  };
}
