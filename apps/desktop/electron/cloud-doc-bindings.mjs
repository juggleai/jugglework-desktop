import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const schemaVersion = 2;

/**
 * 创建 Word 与云文档关联记录仓库；正文和登录凭据不写入该文件。
 * @param {{filePath:string}} options 本机用户目录中的固定 JSON 文件
 */
export function createCloudDocBindingsStore({ filePath }) {
  let queue = Promise.resolve();
  const resourcesRoot = path.join(
    path.dirname(filePath),
    "cloud-doc-checkpoints",
  );

  const empty = () => ({ schemaVersion, bindings: [] });
  const read = async () => {
    try {
      const value = JSON.parse(await readFile(filePath, "utf8"));
      if (value?.schemaVersion !== schemaVersion || !Array.isArray(value.bindings))
        throw new Error("unsupported_cloud_doc_bindings_schema");
      const bindings = value.bindings.filter(
        (item) =>
          item &&
          /^[a-f0-9-]{36}$/i.test(item.attachmentId ?? "") &&
          typeof item.documentId === "string" &&
          typeof item.tenantId === "string" &&
          typeof item.pageId === "string",
      );
      // TIPS: 原子写只能防进程内中断；磁盘损坏或未知版本必须保留现场，不能按空仓库覆盖恢复指针。
      if (bindings.length !== value.bindings.length)
        throw new Error("invalid_cloud_doc_bindings");
      return { schemaVersion, bindings };
    } catch (error) {
      if (error?.code === "ENOENT") return empty();
      throw error;
    }
  };

  const write = async (value) => {
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, filePath);
  };

  /** TIPS: 主进程写入极少，串行化只防止两个原子替换相互覆盖，不引入锁服务。 */
  const mutate = (action) => {
    const task = queue.then(async () => {
      const value = await read();
      action(value);
      await write(value);
      return value;
    });
    queue = task.catch(() => undefined);
    return task;
  };

  return {
    /** 启动时把旧 active 记录降为 paused；有检查点也必须重新授权并完成恢复握手。 */
    pauseUnrestorableAfterRestart() {
      return mutate((value) => {
        for (const item of value.bindings) {
          if (item.state !== "active") continue;
          item.state = "paused";
          item.pauseReason = item.checkpoint
            ? "restart_recovery_required"
            : "restart_requires_common_checkpoint";
          item.updatedAt = new Date().toISOString();
        }
      });
    },
    /** 读取本机全部关联元数据。 */
    async list() {
      await queue;
      const value = await read();
      return value.bindings;
    },
    /** 写入或替换同一 attachmentId／本地文件的当前关联，不保存正文内容。 */
    upsert(binding) {
      return mutate((value) => {
        value.bindings = value.bindings.filter(
          (item) =>
            item.attachmentId !== binding.attachmentId &&
            item.documentId !== binding.documentId,
        );
        value.bindings.push({
          ...binding,
          mappingVersion: 1,
          checkpoint: binding.checkpoint ?? null,
          updatedAt: new Date().toISOString(),
        });
      });
    },
    /** 更新关联生命周期；暂停保留定位信息，显式解除仍保留审计状态。 */
    setState(attachmentId, state, pauseReason) {
      return mutate((value) => {
        const item = value.bindings.find(
          (entry) => entry.attachmentId === attachmentId,
        );
        if (!item) return;
        item.state = state;
        item.pauseReason = pauseReason || null;
        item.updatedAt = new Date().toISOString();
      });
    },
    /**
     * 先写不可变 Y.Doc／映射资源，再原子推进关联指针；失败时仍沿用上一份完整检查点。
     * @param {{attachmentId:string,localSavedFileSha256:string,nativeStateVector:string,nativeSnapshot:string,nativeSchemaVersion:number,bindings:any[],mappingCheckpoint:any,confirmedAt:number}} input 已复核未变化的保存证明
     */
    async commitCheckpoint(input) {
      if (
        !/^[a-f0-9-]{36}$/i.test(input?.attachmentId ?? "") ||
        !/^[a-f0-9]{64}$/.test(input?.localSavedFileSha256 ?? "") ||
        !Number.isSafeInteger(input?.confirmedAt) ||
        input.confirmedAt <= 0 ||
        input?.nativeSchemaVersion !== 1 ||
        !Array.isArray(input?.bindings) ||
        input?.mappingCheckpoint?.schemaVersion !== 1
      )
        throw new Error("invalid_common_checkpoint");
      if (JSON.stringify(input.mappingCheckpoint).length > 16 * 1024 * 1024)
        throw new Error("mapping_checkpoint_too_large");
      const decode = (value) => {
        if (
          typeof value !== "string" ||
          value.length === 0 ||
          value.length > 24 * 1024 * 1024 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
        )
          throw new Error("invalid_common_checkpoint");
        const bytes = Buffer.from(value, "base64");
        if (!bytes.length || bytes.toString("base64") !== value)
          throw new Error("invalid_common_checkpoint");
        return bytes;
      };
      decode(input.nativeStateVector);
      const nativeSnapshot = decode(input.nativeSnapshot);
      if (nativeSnapshot.byteLength > 16 * 1024 * 1024)
        throw new Error("common_checkpoint_too_large");

      const checkpointId = randomUUID();
      const parent = path.join(resourcesRoot, input.attachmentId);
      const finalDirectory = path.join(parent, checkpointId);
      const temporaryDirectory = path.join(parent, `.${checkpointId}.tmp`);
      await mkdir(parent, { recursive: true });
      await mkdir(temporaryDirectory);
      try {
        await writeFile(
          path.join(temporaryDirectory, "native.ydoc"),
          nativeSnapshot,
          { mode: 0o600, flag: "wx" },
        );
        await writeFile(
          path.join(temporaryDirectory, "mapping.json"),
          `${JSON.stringify(
            {
              schemaVersion: 1,
              attachmentId: input.attachmentId,
              checkpointId,
              bindings: input.bindings,
              mappingCheckpoint: input.mappingCheckpoint,
            },
            null,
            2,
          )}\n`,
          { mode: 0o600, flag: "wx" },
        );
        await rename(temporaryDirectory, finalDirectory);
      } catch (error) {
        await rm(temporaryDirectory, { recursive: true, force: true }).catch(
          () => undefined,
        );
        throw error;
      }

      const resource = (name) =>
        path.posix.join(
          "cloud-doc-checkpoints",
          input.attachmentId,
          checkpointId,
          name,
        );
      let checkpoint;
      let obsoleteCheckpointId = null;
      try {
        await mutate((value) => {
          const item = value.bindings.find(
            (entry) => entry.attachmentId === input.attachmentId,
          );
          if (!item) throw new Error("cloud_doc_binding_not_found");
          const prior = item.checkpoint
            ? { ...item.checkpoint, previous: undefined }
            : null;
          obsoleteCheckpointId = item.checkpoint?.previous?.checkpointId ?? null;
          checkpoint = {
            checkpointId,
            localSavedFileSha256: input.localSavedFileSha256,
            nativeStateVector: input.nativeStateVector,
            nativeSnapshotRef: resource("native.ydoc"),
            mappingCheckpointRef: resource("mapping.json"),
            mappingVersion: 1,
            nativeSchemaVersion: input.nativeSchemaVersion,
            confirmedAt: input.confirmedAt,
            previous: prior,
          };
          item.bindings = input.bindings;
          item.mappingVersion = 1;
          item.checkpoint = checkpoint;
          item.state = "active";
          item.pauseReason = null;
          item.updatedAt = new Date().toISOString();
        });
      } catch (error) {
        await rm(finalDirectory, { recursive: true, force: true }).catch(
          () => undefined,
        );
        throw error;
      }
      // TIPS: 指针已安全落盘后才清理第三旧资源，始终保留当前和上一份完整检查点。
      if (/^[a-f0-9-]{36}$/i.test(obsoleteCheckpointId ?? ""))
        await rm(path.join(parent, obsoleteCheckpointId), {
          recursive: true,
          force: true,
        }).catch(() => undefined);
      return checkpoint;
    },
    /** 按当前账号、租户和本地文件精确查找可恢复关联，不按同名或 pageId 猜测。 */
    async findRecoverable(input) {
      await queue;
      const value = await read();
      const item = value.bindings.find(
        (entry) =>
          entry.state === "paused" &&
          entry.checkpoint &&
          entry.sourceServerOrigin === input.sourceServerOrigin &&
          entry.sourceUserId === input.sourceUserId &&
          entry.tenantId === input.tenantId &&
          entry.localWorkspaceId === input.localWorkspaceId &&
          entry.relativePath === input.relativePath,
      );
      return item
        ? {
            attachmentId: item.attachmentId,
            docsWorkspaceId: item.docsWorkspaceId,
            pageId: item.pageId,
          }
        : null;
    },
    /**
     * 按共同检查点摘要查找唯一的已移动文件候选；不按文件名、pageId 或相对路径相似度猜测。
     * @param {{sourceServerOrigin:string,sourceUserId:string,tenantId:string,localWorkspaceId:string,relativePath:string,savedFileSha256:string}} input 当前已打开的真实文件身份
     */
    async findRelocatable(input) {
      if (!/^[a-f0-9]{64}$/.test(input?.savedFileSha256 ?? "")) return null;
      await queue;
      const value = await read();
      const matches = value.bindings.filter(
        (entry) =>
          entry.state === "paused" &&
          entry.checkpoint?.localSavedFileSha256 === input.savedFileSha256 &&
          entry.sourceServerOrigin === input.sourceServerOrigin &&
          entry.sourceUserId === input.sourceUserId &&
          entry.tenantId === input.tenantId &&
          entry.localWorkspaceId === input.localWorkspaceId &&
          entry.relativePath !== input.relativePath,
      );
      if (matches.length !== 1) return null;
      const item = matches[0];
      return {
        attachmentId: item.attachmentId,
        docsWorkspaceId: item.docsWorkspaceId,
        pageId: item.pageId,
        previousRelativePath: item.relativePath,
      };
    },
    /**
     * 用户确认后把唯一候选重新定位到当前文件；提交时再次核对账号、租户和真实文件摘要。
     * @param {{attachmentId:string,documentId:string,sourceServerOrigin:string,sourceUserId:string,tenantId:string,localWorkspaceId:string,relativePath:string,savedFileSha256:string}} input 当前文件和待迁移关联
     */
    relocate(input) {
      if (
        !/^[a-f0-9-]{36}$/i.test(input?.attachmentId ?? "") ||
        typeof input?.documentId !== "string" ||
        !input.documentId ||
        typeof input?.relativePath !== "string" ||
        !input.relativePath ||
        !/^[a-f0-9]{64}$/.test(input?.savedFileSha256 ?? "")
      )
        throw new Error("invalid_word_relocation");
      return mutate((value) => {
        const conflict = value.bindings.some(
          (entry) =>
            entry.attachmentId !== input.attachmentId &&
            entry.state !== "unlinked" &&
            (entry.documentId === input.documentId ||
              (entry.sourceServerOrigin === input.sourceServerOrigin &&
                entry.sourceUserId === input.sourceUserId &&
                entry.tenantId === input.tenantId &&
                entry.localWorkspaceId === input.localWorkspaceId &&
                entry.relativePath === input.relativePath)),
        );
        if (conflict) throw new Error("word_relocation_conflict");
        const matches = value.bindings.filter(
          (entry) =>
            entry.attachmentId === input.attachmentId &&
            entry.state === "paused" &&
            entry.checkpoint?.localSavedFileSha256 ===
              input.savedFileSha256 &&
            entry.sourceServerOrigin === input.sourceServerOrigin &&
            entry.sourceUserId === input.sourceUserId &&
            entry.tenantId === input.tenantId &&
            entry.localWorkspaceId === input.localWorkspaceId,
        );
        if (matches.length !== 1) throw new Error("word_relocation_not_found");
        const item = matches[0];
        item.documentId = input.documentId;
        item.relativePath = input.relativePath;
        item.pauseReason = "relocation_confirmed";
        item.updatedAt = new Date().toISOString();
      });
    },
    /** 读取并核对不可变恢复资源；引用必须严格落在该关联和检查点目录。 */
    async loadRecovery(input) {
      await queue;
      const value = await read();
      const item = value.bindings.find(
        (entry) =>
          entry.attachmentId === input.attachmentId &&
          entry.state === "paused" &&
          entry.checkpoint &&
          entry.sourceServerOrigin === input.sourceServerOrigin &&
          entry.sourceUserId === input.sourceUserId &&
          entry.tenantId === input.tenantId &&
          entry.localWorkspaceId === input.localWorkspaceId &&
          entry.relativePath === input.relativePath,
      );
      if (!item) throw new Error("word_recovery_not_found");
      const checkpoint = item.checkpoint;
      const expected = (name) =>
        path.posix.join(
          "cloud-doc-checkpoints",
          item.attachmentId,
          checkpoint.checkpointId,
          name,
        );
      if (
        checkpoint.nativeSnapshotRef !== expected("native.ydoc") ||
        checkpoint.mappingCheckpointRef !== expected("mapping.json")
      )
        throw new Error("word_recovery_resource_invalid");
      const [nativeSnapshot, mappingRaw] = await Promise.all([
        readFile(path.join(path.dirname(filePath), checkpoint.nativeSnapshotRef)),
        readFile(
          path.join(path.dirname(filePath), checkpoint.mappingCheckpointRef),
          "utf8",
        ),
      ]);
      const mapping = JSON.parse(mappingRaw);
      if (
        mapping?.schemaVersion !== 1 ||
        mapping.attachmentId !== item.attachmentId ||
        mapping.checkpointId !== checkpoint.checkpointId ||
        mapping.mappingCheckpoint?.schemaVersion !== 1 ||
        JSON.stringify(mapping.bindings) !== JSON.stringify(item.bindings)
      )
        throw new Error("word_recovery_mapping_invalid");
      return {
        binding: item,
        recoveryCheckpoint: {
          nativeSnapshot: nativeSnapshot.toString("base64"),
          nativeStateVector: checkpoint.nativeStateVector,
          mappingCheckpoint: mapping.mappingCheckpoint,
        },
      };
    },
  };
}
