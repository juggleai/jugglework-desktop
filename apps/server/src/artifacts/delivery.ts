import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  ArtifactOrigin,
  FileDeliveryTarget,
  SessionFileArtifacts,
} from "@jugglework/types/file-artifacts";
import {
  opencodeAdmissionId,
  type AdmissionIdentity,
} from "../opencode-admission.js";
import { ArtifactRegistry, type ObservedArtifactFile } from "./registry.js";

/** 引擎消息的交付相关字段；仅使用真实 parentID 与已完成工具结果。 */
export interface ArtifactEngineMessage {
  info: {
    id: string;
    role: string;
    parentID?: string | null;
    time?: { created?: number; completed?: number };
  };
  parts: unknown[];
}

const WRITE_TOOLS = new Set([
  "write",
  "write_file",
  "edit",
  "edit_file",
  "multiedit",
  "multi_edit",
  "apply_patch",
  "patch",
]);
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** 从成功写入的结构化参数提取交付目标，不扫描消息正文或工作区修改时间。 */
export function artifactPathsFromTool(part: Record<string, unknown>): string[] {
  const state = record(part.state);
  if (part.type !== "tool" || state.status !== "completed") return [];
  if (part.tool === "jugglework_image_generate") {
    let output = state.output;
    if (typeof output === "string") {
      try {
        output = JSON.parse(output);
      } catch {
        return [];
      }
    }
    const result = record(output);
    const artifact = record(record(result.result).artifact);
    return result.ok === true &&
      typeof artifact.path === "string" &&
      String(artifact.mimeType).startsWith("image/")
      ? [artifact.path]
      : [];
  }
  if (!WRITE_TOOLS.has(String(part.tool).toLowerCase())) return [];
  const input = record(state.input);
  const paths = [input.filePath, input.file_path, input.path];
  if (Array.isArray(input.edits))
    for (const edit of input.edits) {
      const fields = record(edit);
      paths.push(fields.filePath, fields.file_path, fields.path);
    }
  if (typeof input.patchText === "string" || typeof input.patch === "string") {
    let updatedPath: string | undefined;
    for (const line of String(input.patchText ?? input.patch).split("\n")) {
      const match = /^\*\*\* (Add File|Update File|Move to):\s*(.+)$/.exec(
        line,
      );
      if (!match) continue;
      if (match[1] === "Move to" && updatedPath)
        paths.splice(paths.indexOf(updatedPath), 1);
      paths.push(match[2]);
      updatedPath = match[1] === "Update File" ? match[2] : undefined;
    }
  }
  return [
    ...new Set(
      paths.filter(
        (path): path is string =>
          typeof path === "string" && Boolean(path.trim()),
      ),
    ),
  ]
    .filter(
      (path) =>
        !/(?:^|[\\/])(?:node_modules|\.git|\.opencode|\.cache|__pycache__)(?:[\\/]|$)/.test(
          path,
        ),
    )
    .filter((path) => !/^(?:\.\/)?(?:src|vendor)[\\/]/.test(path))
    .filter(
      (path) =>
        !/\.(?:tsx?|jsx?|mjs|cjs|py|rb|go|rs|java|kt|swift|php|[ch]|cpp|cs|sh|bash|zsh|lock)$/i.test(
          path,
        ),
    );
}

/**
 * 协调运行归属、文件保存确认及历史记录；保存回调由 Office 服务在接入时提供。
 * 模型终止事件不被延迟或篡改，文件交付单独进入 finalizing。
 */
export class FileDeliveryService {
  private readonly registries = new Map<string, ArtifactRegistry>();
  constructor(
    private readonly options: {
      workspace: (workspaceId: string) => { id: string; path: string };
      readMessages: (
        workspaceId: string,
        sessionId: string,
      ) => Promise<ArtifactEngineMessage[]>;
      inspect: (
        workspaceId: string,
        path: string,
      ) => Promise<ObservedArtifactFile | null>;
      saveTarget?: (
        workspaceId: string,
        origin: ArtifactOrigin,
        target: FileDeliveryTarget,
      ) => Promise<void>;
      readMediaJob?: (
        workspaceId: string,
        sessionId: string,
        requestId: string,
      ) => {
        id: string;
        status: string;
        artifact?: { path: string };
        error?: { message: string };
      } | null;
    },
  ) {}

  /** 使用真正传给引擎的用户消息 ID 绑定运行，自动生成的 ID 在重试同一 run 时不变。 */
  preparePrompt(
    workspaceId: string,
    sessionId: string,
    runId: string,
    prompt: Record<string, unknown>,
  ): Record<string, unknown> {
    const turnId =
      typeof prompt.messageID === "string" && prompt.messageID
        ? prompt.messageID
        : `msg_${createHash("sha256")
            .update(JSON.stringify([workspaceId, sessionId, runId]))
            .digest("hex")}`;
    this.registry(workspaceId).begin({ sessionId, turnId, runId });
    return { ...prompt, messageID: turnId };
  }

  /**
   * 在 v2 admission 提交前绑定真正发给引擎的消息 ID，重试和重启沿用同一归属。
   * @param identity 本地排队、追加或远程待执行请求的既有身份
   */
  prepareAdmission(identity: AdmissionIdentity): ArtifactOrigin {
    const turnId = opencodeAdmissionId(identity);
    const origin = {
      sessionId: identity.sessionId,
      turnId,
      runId: `admission:${turnId}`,
    };
    this.registry(identity.workspaceId).begin(origin);
    return origin;
  }

  /** 读取单工作区记录；只有一个常驻 Server 实例持有并写入它。 */
  registry(workspaceId: string): ArtifactRegistry {
    let registry = this.registries.get(workspaceId);
    if (!registry) {
      const workspace = this.options.workspace(workspaceId);
      registry = new ArtifactRegistry(workspaceId, workspace.path);
      this.registries.set(workspaceId, registry);
    }
    return registry;
  }

  /** 批量查询当前元信息，历史快照保持原值；文件删除仍保留原交付。 */
  async list(
    workspaceId: string,
    sessionId: string,
  ): Promise<SessionFileArtifacts> {
    const registry = this.registry(workspaceId);
    for (const turn of registry.list(sessionId).turns) {
      for (const target of turn.targets) {
        if (
          target.source !== "media" ||
          target.status !== "pending" ||
          !this.options.readMediaJob
        )
          continue;
        const origin = { sessionId, turnId: turn.turnId, runId: target.runId };
        const job = this.options.readMediaJob(
          workspaceId,
          sessionId,
          target.key.slice("media:".length),
        );
        if (job?.status === "completed" && job.artifact) {
          const observed = await this.options.inspect(
            workspaceId,
            job.artifact.path,
          );
          if (observed?.exists) registry.confirm(origin, target.key, observed);
          else registry.fail(origin, target.key, "生成结果文件已不存在", false);
        } else if (
          job &&
          ["failed", "cancelled", "submission_unknown"].includes(job.status)
        ) {
          registry.fail(
            origin,
            target.key,
            job.error?.message ?? "媒体任务未完成",
            false,
          );
        }
      }
    }
    for (const file of registry.list(sessionId).files) {
      const observed = await this.options.inspect(
        workspaceId,
        file.relativePath,
      );
      if (observed) registry.resolve(observed);
    }
    return registry.list(sessionId);
  }

  /** 付费任务提交前按实际工具消息的父消息固定归属，不能回退到当前焦点轮次。 */
  async bindMediaSubmission(
    workspaceId: string,
    sessionId: string,
    messageId: string,
    requestId: string,
  ): Promise<ArtifactOrigin | null> {
    const registry = this.registry(workspaceId);
    const key = `media:${requestId}`;
    // TIPS: 同一付费请求重试必须沿用首次归属，不能把已提交的任务挂到后来的消息。
    for (const turn of registry.list(sessionId).turns) {
      const target = turn.targets.find((item) => item.key === key);
      if (target)
        return { sessionId, turnId: turn.turnId, runId: target.runId };
    }
    const messages = await this.options.readMessages(workspaceId, sessionId);
    const message = messages.find(
      (item) => item.info.id === messageId && item.info.role === "assistant",
    );
    const turn = this.registry(workspaceId)
      .list(sessionId)
      .turns.find((item) => item.turnId === message?.info.parentID);
    if (!turn) return null;
    const origin = {
      sessionId,
      turnId: turn.turnId,
      runId: turn.runIds.at(-1)!,
    };
    registry.track(origin, { key, path: null, source: "media" });
    return origin;
  }

  /** 分配本次生成专用目录；在命令运行前持久化真实父消息和执行归属。 */
  async prepareGeneration(
    workspaceId: string,
    sessionId: string,
    messageId: string,
    outputs: string[],
  ): Promise<{ generationId: string; outputDirectory: string }> {
    const origin = await this.messageOrigin(workspaceId, sessionId, messageId);
    if (!origin) throw new Error("artifact_origin_not_found");
    const generationId = `gen_${randomUUID()}`;
    const directory = `artifacts/generated/${generationId}`;
    const outputDirectory = join(
      this.options.workspace(workspaceId).path,
      directory,
    );
    await mkdir(outputDirectory, { recursive: true });
    this.registry(workspaceId).track(origin, {
      key: generationId,
      source: "generation",
      path: null,
      outputDirectory: directory,
      outputs,
    });
    return { generationId, outputDirectory };
  }

  /** 宿主按进程退出结果自动枚举专用目录及声明路径，不解析 stdout，也不重放命令。 */
  async completeGeneration(
    workspaceId: string,
    sessionId: string,
    generationId: string,
    exitCode: number | null,
  ): Promise<SessionFileArtifacts> {
    const registry = this.registry(workspaceId);
    const turn = registry
      .list(sessionId)
      .turns.find((entry) =>
        entry.targets.some(
          (target) =>
            target.key === generationId && target.source === "generation",
        ),
      );
    const target = turn?.targets.find((entry) => entry.key === generationId);
    if (!turn || !target?.outputDirectory)
      throw new Error("artifact_generation_not_found");
    const origin = { sessionId, turnId: turn.turnId, runId: target.runId };
    if (target.status !== "pending") return this.list(workspaceId, sessionId);
    if (exitCode !== 0) {
      registry.fail(
        origin,
        generationId,
        "生成进程未成功结束，残留文件未交付",
        false,
      );
      return this.list(workspaceId, sessionId);
    }
    const declaredPaths = [...(target.outputs ?? [])];
    const generatedPaths: string[] = [];
    const workspace = this.options.workspace(workspaceId);
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(join(workspace.path, directory), {
        withFileTypes: true,
      })) {
        if (generatedPaths.length >= 2000)
          throw new Error("生成文件过多，请缩小输出范围");
        const path = `${directory}/${entry.name}`;
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile()) generatedPaths.push(path);
      }
    };
    try {
      await walk(target.outputDirectory);
    } catch (error) {
      registry.fail(
        origin,
        generationId,
        error instanceof Error ? error.message : "读取生成目录失败",
        false,
      );
      return this.list(workspaceId, sessionId);
    }
    const normalizedOutput = (value: string) =>
      value.replace(/\\/g, "/").replace(/^\.\//, "");
    const generatedRelativePaths = new Set(
      generatedPaths.map((path) => {
        const prefix = `${target.outputDirectory}/`;
        return normalizedOutput(path).startsWith(prefix)
          ? normalizedOutput(path).slice(prefix.length)
          : normalizedOutput(path);
      }),
    );
    // Programs run inside the dedicated generation directory. A declared
    // output such as "report.docx" therefore names the same file as the
    // automatically collected "artifacts/generated/<id>/report.docx". Do not
    // create a second failed target for that alias; declarations elsewhere in
    // the workspace remain independent and are still validated explicitly.
    const externalDeclaredPaths = declaredPaths.filter(
      (path) => !generatedRelativePaths.has(normalizedOutput(path)),
    );
    const uniquePaths = [...new Set([...externalDeclaredPaths, ...generatedPaths])];
    if (!uniquePaths.length) {
      registry.fail(origin, generationId, "未找到交付文件", false);
      return this.list(workspaceId, sessionId);
    }
    for (const path of uniquePaths) {
      const key = `${generationId}:${path}`;
      registry.track(origin, { key, source: "generation", path });
      try {
        const observed = await this.options.inspect(workspaceId, path);
        if (observed?.exists) registry.confirm(origin, key, observed);
        else registry.fail(origin, key, "声明的输出文件不存在", false);
      } catch (error) {
        registry.fail(
          origin,
          key,
          error instanceof Error ? error.message : "文件校验失败",
          false,
        );
      }
    }
    registry.completeTarget(origin, generationId);
    return this.list(workspaceId, sessionId);
  }

  /** 补充用户明确指定的现有文件；不扫描工作区，不把失败生成的残留自动登记。 */
  async registerOutputs(
    workspaceId: string,
    sessionId: string,
    messageId: string,
    paths: string[],
  ): Promise<SessionFileArtifacts> {
    const origin = await this.messageOrigin(workspaceId, sessionId, messageId);
    if (!origin) throw new Error("artifact_origin_not_found");
    const registry = this.registry(workspaceId);
    for (const path of [...new Set(paths)]) {
      const key = `register:${messageId}:${path}`;
      registry.track(origin, { key, source: "tool", path });
      const observed = await this.options.inspect(workspaceId, path);
      if (observed?.exists) registry.confirm(origin, key, observed);
      else registry.fail(origin, key, "指定文件不存在", true);
    }
    return this.list(workspaceId, sessionId);
  }

  private async messageOrigin(
    workspaceId: string,
    sessionId: string,
    messageId: string,
  ): Promise<ArtifactOrigin | null> {
    const messages = await this.options.readMessages(workspaceId, sessionId);
    const message = messages.find(
      (item) => item.info.id === messageId && item.info.role === "assistant",
    );
    const turn = this.registry(workspaceId)
      .list(sessionId)
      .turns.find((item) => item.turnId === message?.info.parentID);
    const runId = turn?.runIds.at(-1);
    return turn && runId && !turn.finishedRunIds.includes(runId)
      ? { sessionId, turnId: turn.turnId, runId }
      : null;
  }

  /** 按真实工具调用及父消息登记 Office 修改，最终交付时由宿主保存该文档。 */
  async bindOfficeModification(
    workspaceId: string,
    sessionId: string,
    messageId: string,
    callId: string,
    documentId: string,
    path: string,
  ): Promise<void> {
    let actualMessageId = messageId;
    if (!actualMessageId) {
      const messages = await this.options.readMessages(workspaceId, sessionId);
      actualMessageId =
        messages.find(
          (message) =>
            message.info.role === "assistant" &&
            message.parts.some((part) => record(part).callID === callId),
        )?.info.id ?? "";
    }
    const origin = await this.messageOrigin(
      workspaceId,
      sessionId,
      actualMessageId,
    );
    if (!origin) return;
    this.registry(workspaceId).track(origin, {
      key: `office:${documentId}:${callId}`,
      documentId,
      path,
      source: "office",
    });
  }

  /** 按引擎真实父消息归属收集成功写入；旧会话没有绑定时沿用前端兼容展示。 */
  async collect(
    workspaceId: string,
    sessionId: string,
  ): Promise<ArtifactEngineMessage[]> {
    const registry = this.registry(workspaceId);
    const turns = registry.list(sessionId).turns;
    if (!turns.length) return [];
    const messages = await this.options.readMessages(workspaceId, sessionId);
    for (const message of messages) {
      if (message.info.role !== "assistant" || !message.info.parentID) continue;
      const turn = turns.find(
        (candidate) => candidate.turnId === message.info.parentID,
      );
      if (!turn) continue;
      const origin: ArtifactOrigin = {
        sessionId,
        turnId: turn.turnId,
        runId: turn.runIds.at(-1)!,
      };
      for (const raw of message.parts) {
        const part = record(raw);
        for (const path of artifactPathsFromTool(part)) {
          registry.track(origin, {
            key: `${String(part.callID ?? part.id)}:${path}`,
            path,
            source: "tool",
          });
        }
      }
    }
    return messages;
  }

  /** 运行结束后先收集最终工具结果，再确认已保存的文件；失败按文件保留。 */
  async finishRun(
    workspaceId: string,
    sessionId: string,
    runId: string,
  ): Promise<void> {
    const registry = this.registry(workspaceId);
    if (!registry.originsForRun(runId).length) return;
    await this.collect(workspaceId, sessionId);
    registry.finishRun(runId);
    for (const origin of registry.originsForRun(runId))
      await this.confirmPending(workspaceId, origin);
  }

  /** 引擎确认空闲后恢复未完成的交付；只读取工具结果及文件，不重放生成。 */
  async synchronize(
    workspaceId: string,
    sessionId: string,
    idle: boolean,
  ): Promise<SessionFileArtifacts> {
    if (idle) {
      const messages = await this.collect(workspaceId, sessionId);
      const registry = this.registry(workspaceId);
      for (const turn of registry.list(sessionId).turns) {
        for (const runId of turn.runIds) {
          // TIPS: admission 回执只代表排队成功；空闲快照不能把尚未执行的队列提前结束。
          if (
            runId.startsWith("admission:") &&
            !turn.finishedRunIds.includes(runId)
          ) {
            const replies = messages.filter(
              (message) =>
                message.info.role === "assistant" &&
                message.info.parentID === turn.turnId,
            );
            if (
              !replies.length ||
              replies.some(
                (message) =>
                  typeof message.info.time?.completed !== "number" ||
                  message.parts.some((raw) => {
                    const part = record(raw);
                    return (
                      part.type === "tool" &&
                      ["pending", "running"].includes(
                        String(record(part.state).status),
                      )
                    );
                  }),
              )
            )
              continue;
          }
          registry.finishRun(runId);
          await this.confirmPending(workspaceId, {
            sessionId,
            turnId: turn.turnId,
            runId,
          });
        }
      }
    }
    return this.list(workspaceId, sessionId);
  }

  /** 只重试失败的保存与校验，不再次运行 Shell、Python 或媒体生成。 */
  async retry(
    workspaceId: string,
    sessionId: string,
    turnId: string,
  ): Promise<SessionFileArtifacts> {
    const turn = this.registry(workspaceId)
      .list(sessionId)
      .turns.find((entry) => entry.turnId === turnId);
    if (!turn) throw new Error("artifact_turn_not_found");
    if (turn.runIds.some((runId) => !turn.finishedRunIds.includes(runId)))
      throw new Error("artifact_run_not_finished");
    for (const runId of turn.runIds)
      await this.confirmPending(
        workspaceId,
        { sessionId, turnId, runId },
        true,
      );
    return this.list(workspaceId, sessionId);
  }

  private async confirmPending(
    workspaceId: string,
    origin: ArtifactOrigin,
    retry = false,
  ): Promise<void> {
    const registry = this.registry(workspaceId);
    const turn = registry
      .list(origin.sessionId)
      .turns.find((entry) => entry.turnId === origin.turnId)!;
    for (const target of turn.targets) {
      if (target.runId !== origin.runId || target.status === "ready") continue;
      if (target.source === "media") {
        if (
          !this.options.readMediaJob?.(
            workspaceId,
            origin.sessionId,
            target.key.slice("media:".length),
          )
        ) {
          registry.fail(
            origin,
            target.key,
            "媒体任务尚未提交，未自动重新生成",
            false,
          );
        }
        continue;
      }
      if (target.source === "generation" && target.status === "pending") {
        registry.fail(
          origin,
          target.key,
          "未确认生成进程成功结束，未自动重新执行",
          false,
        );
        continue;
      }
      if (!target.path || target.source === "generation") continue;
      if (target.status === "failed" && (!retry || !target.retryable)) continue;
      try {
        if (target.source === "office") {
          if (!this.options.saveTarget)
            throw new Error("Office 保存服务尚未接入");
          await this.options.saveTarget(workspaceId, origin, target);
        }
        const observed = await this.options.inspect(workspaceId, target.path);
        if (!observed?.exists) throw new Error("文件不存在，尚未确认交付");
        registry.confirm(origin, target.key, observed);
      } catch (cause) {
        registry.fail(
          origin,
          target.key,
          cause instanceof Error ? cause.message : "文件交付确认失败",
          true,
        );
      }
    }
  }
}
