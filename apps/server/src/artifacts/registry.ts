import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  ArtifactOrigin,
  FileArtifact,
  FileDeliveryTarget,
  SessionFileArtifacts,
  TurnArtifact,
  TurnDelivery,
} from "@jugglework/types/file-artifacts";

/** 由既有工作区文件解析器返回的实际磁盘状态。 */
export interface ObservedArtifactFile {
  value: string;
  name: string;
  preview: string;
  contentType?: string;
  exists: boolean;
  size?: number;
  updatedAt?: number;
}

interface ArtifactManifest {
  version: 1;
  workspaceId: string;
  files: FileArtifact[];
  turns: TurnDelivery[];
}

/**
 * 单工作区产物记录。常驻 Server 唯一写入，使用同步原子替换保证元数据更新完整。
 * 不引入数据库、跨进程锁或生成命令重放。
 */
export class ArtifactRegistry {
  private readonly manifestPath: string;
  private readonly files = new Map<string, FileArtifact>();
  private readonly turns = new Map<string, TurnDelivery>();

  constructor(
    private readonly workspaceId: string,
    workspaceRoot: string,
  ) {
    this.manifestPath = join(
      workspaceRoot,
      ".opencode",
      "jugglework",
      "artifacts",
      "manifest.json",
    );
    if (!existsSync(this.manifestPath)) return;
    const manifest = JSON.parse(
      readFileSync(this.manifestPath, "utf8"),
    ) as ArtifactManifest;
    if (
      manifest.version !== 1 ||
      manifest.workspaceId !== workspaceId ||
      !Array.isArray(manifest.files) ||
      !Array.isArray(manifest.turns)
    ) {
      throw new Error("artifact_manifest_invalid");
    }
    for (const file of manifest.files) this.files.set(file.artifactId, file);
    for (const turn of manifest.turns)
      this.turns.set(this.turnKey(turn.sessionId, turn.turnId), turn);
  }

  /** 绑定真实轮次与执行批次；同一 admission 或运行重放不重复建立记录。 */
  begin(origin: ArtifactOrigin): TurnDelivery {
    const key = this.turnKey(origin.sessionId, origin.turnId);
    let turn = this.turns.get(key);
    if (!turn) {
      turn = {
        sessionId: origin.sessionId,
        turnId: origin.turnId,
        runIds: [],
        finishedRunIds: [],
        status: "collecting",
        targets: [],
        items: [],
      };
      this.turns.set(key, turn);
    }
    if (!turn.runIds.includes(origin.runId)) {
      turn.runIds.push(origin.runId);
      turn.status = "collecting";
      this.persist();
    }
    return structuredClone(turn);
  }

  /** 保存固定轮次的选区展示和模式标记；重试不能替换同消息的引用。 */
  recordOfficeSelection(origin: ArtifactOrigin, selection: NonNullable<TurnDelivery["officeSelection"]>): void {
    const turn = this.requireTurn(origin);
    if (turn.officeSelection) {
      if (JSON.stringify(turn.officeSelection) !== JSON.stringify(selection)) throw new Error("office_selection_admission_changed");
      return;
    }
    turn.officeSelection = structuredClone(selection);
    this.persist();
  }

  /** 记录文件或后台任务目标；已有 key 保留已确认结果及原始归属。 */
  track(
    origin: ArtifactOrigin,
    target: Omit<FileDeliveryTarget, "runId" | "status">,
  ): FileDeliveryTarget {
    this.begin(origin);
    const turn = this.turns.get(this.turnKey(origin.sessionId, origin.turnId))!;
    const existing = turn.targets.find((item) => item.key === target.key);
    if (existing) return structuredClone(existing);
    const next: FileDeliveryTarget = {
      ...target,
      runId: origin.runId,
      status: "pending",
    };
    turn.targets.push(next);
    this.updateStatus(turn);
    this.persist();
    return structuredClone(next);
  }

  /** 保存成功并确认文件后发布快照；ready 事件重放不能用当前文件覆写旧快照。 */
  confirm(
    origin: ArtifactOrigin,
    key: string,
    observed: ObservedArtifactFile,
    history = false,
  ): void {
    const turn = this.requireTurn(origin);
    const target = this.requireTarget(turn, key);
    if (target.status === "ready") return;
    if (!observed.exists && !history) throw new Error("artifact_file_missing");
    const file = this.updateFile(observed).file;
    const item: TurnArtifact = {
      sessionId: origin.sessionId,
      turnId: origin.turnId,
      artifactId: file.artifactId,
      source: history ? "history" : "runtime",
      snapshot: {
        name: file.name,
        sizeBytes: history ? null : file.sizeBytes,
        updatedAt: history ? null : file.updatedAt,
      },
    };
    const previous = turn.items.findIndex(
      (entry) => entry.artifactId === file.artifactId,
    );
    if (previous < 0) turn.items.push(item);
    else turn.items[previous] = item;
    Object.assign(target, {
      path: file.relativePath,
      status: "ready",
      artifactId: file.artifactId,
    });
    delete target.error;
    delete target.retryable;
    this.updateStatus(turn);
    this.persist();
  }

  /** 标记具体目标失败；脚本失败的残留文件不可通过“重试确认”冒充完整交付。 */
  fail(
    origin: ArtifactOrigin,
    key: string,
    error: string,
    retryable: boolean,
  ): void {
    const turn = this.requireTurn(origin);
    const target = this.requireTarget(turn, key);
    if (target.status === "ready") return;
    Object.assign(target, { status: "failed", error, retryable });
    this.updateStatus(turn);
    this.persist();
  }

  /** 标记受控生成过程已确认完成，具体文件由各自目标提供快照。 */
  completeTarget(origin: ArtifactOrigin, key: string): void {
    const turn = this.requireTurn(origin);
    const target = this.requireTarget(turn, key);
    if (target.status === "ready") return;
    target.status = "ready";
    delete target.error;
    delete target.retryable;
    this.updateStatus(turn);
    this.persist();
  }

  /** 结束模型运行，文件目标保持独立的待确认或部分失败状态。 */
  finishRun(runId: string): void {
    let changed = false;
    for (const turn of this.turns.values()) {
      if (!turn.runIds.includes(runId) || turn.finishedRunIds.includes(runId))
        continue;
      turn.finishedRunIds.push(runId);
      this.updateStatus(turn);
      changed = true;
    }
    if (changed) this.persist();
  }

  /** 找回运行的真实轮次，用于终止事件、后台完成及重启后恢复。 */
  originsForRun(runId: string): ArtifactOrigin[] {
    return [...this.turns.values()]
      .filter((turn) => turn.runIds.includes(runId))
      .map((turn) => ({
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        runId,
      }));
  }

  /** 查询已登记的轮次及元信息；返回副本避免界面修改内部记录。 */
  list(sessionId: string): SessionFileArtifacts {
    const turns = [...this.turns.values()].filter(
      (turn) => turn.sessionId === sessionId,
    );
    const ids = new Set(
      turns.flatMap((turn) => turn.items.map((item) => item.artifactId)),
    );
    return structuredClone({
      turns,
      files: [...this.files.values()].filter((file) =>
        ids.has(file.artifactId),
      ),
    });
  }

  /** 建立文件身份或刷新当前元信息，不更改历史轮次快照。 */
  resolve(observed: ObservedArtifactFile): FileArtifact {
    const { file, changed } = this.updateFile(observed);
    if (changed) this.persist();
    return structuredClone(file);
  }

  private updateFile(observed: ObservedArtifactFile): {
    file: FileArtifact;
    changed: boolean;
  } {
    const pathKey = (value: string) =>
      process.platform === "win32" ? value.toLowerCase() : value;
    let file = [...this.files.values()].find(
      (entry) => pathKey(entry.relativePath) === pathKey(observed.value),
    );
    const before = JSON.stringify(file);
    if (!file) {
      file = {
        artifactId: `af_${randomUUID()}`,
        workspaceId: this.workspaceId,
        relativePath: observed.value,
        name: observed.name,
        kind: observed.preview,
        mimeType: observed.contentType ?? "application/octet-stream",
        exists: observed.exists,
        sizeBytes: observed.size ?? null,
        updatedAt: observed.updatedAt ?? null,
        editingOwner: "internal",
      };
      this.files.set(file.artifactId, file);
    } else {
      Object.assign(file, {
        name: observed.name,
        kind: observed.preview,
        mimeType: observed.contentType ?? "application/octet-stream",
        exists: observed.exists,
        sizeBytes: observed.size ?? null,
        updatedAt: observed.updatedAt ?? null,
      });
    }
    return { file, changed: before !== JSON.stringify(file) };
  }

  /** 持久化编辑权交接，重启后不能自动恢复对外部文档的写入。 */
  setEditingOwner(path: string, owner: "internal" | "external"): void {
    const file = [...this.files.values()].find((entry) => entry.relativePath === path);
    if (!file || file.editingOwner === owner) return;
    file.editingOwner = owner;
    this.persist();
  }

  /** 宿主重命名时保留身份；无法确认的外部移动不按同名自动重绑定。 */
  rename(from: string, to: string): void {
    const renamed = (path: string) =>
      path === from
        ? to
        : path.startsWith(`${from}/`)
          ? `${to}${path.slice(from.length)}`
          : path;
    let changed = false;
    for (const file of this.files.values()) {
      const next = renamed(file.relativePath);
      if (next === file.relativePath) continue;
      file.relativePath = next;
      file.name = next.split("/").at(-1) ?? next;
      changed = true;
    }
    for (const turn of this.turns.values())
      for (const target of turn.targets) {
        if (!target.path) continue;
        const next = renamed(target.path);
        if (next !== target.path) {
          target.path = next;
          changed = true;
        }
      }
    if (changed) this.persist();
  }

  private requireTurn(origin: ArtifactOrigin): TurnDelivery {
    const turn = this.turns.get(this.turnKey(origin.sessionId, origin.turnId));
    if (!turn?.runIds.includes(origin.runId))
      throw new Error("artifact_origin_not_found");
    return turn;
  }
  private requireTarget(turn: TurnDelivery, key: string): FileDeliveryTarget {
    const target = turn.targets.find((item) => item.key === key);
    if (!target) throw new Error("artifact_target_not_found");
    return target;
  }
  private turnKey(sessionId: string, turnId: string) {
    return JSON.stringify([sessionId, turnId]);
  }
  private updateStatus(turn: TurnDelivery): void {
    if (turn.runIds.some((id) => !turn.finishedRunIds.includes(id))) {
      turn.status = "collecting";
      return;
    }
    if (turn.targets.some((target) => target.status === "pending")) {
      turn.status = "finalizing";
      return;
    }
    const failed = turn.targets.some((target) => target.status === "failed");
    turn.status = failed
      ? turn.items.length > 0
        ? "partial"
        : "failed"
      : "ready";
  }
  private persist(): void {
    mkdirSync(dirname(this.manifestPath), { recursive: true });
    const manifest: ArtifactManifest = {
      version: 1,
      workspaceId: this.workspaceId,
      files: [...this.files.values()],
      turns: [...this.turns.values()],
    };
    // TIPS: 所有 Map 更新和原子落盘在同一同步调用内完成，Server 不需要额外的写锁。
    const temporary = `${this.manifestPath}.tmp`;
    writeFileSync(temporary, JSON.stringify(manifest));
    renameSync(temporary, this.manifestPath);
  }
}
