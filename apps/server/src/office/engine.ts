import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer, type AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OFFICE_EDITABLE_FORMATS,
  type OfficeCapabilities,
} from "@jugglework/types/office";
import type { OfficeToolDefinition } from "./content-tools.js";
import { finalizeXlsxExport } from "./xlsx-export.js";
import { loopbackFetch } from "../server-fetch.js";

interface NativeEditor {
  file_id: string;
  file_path: string;
  is_dirty: boolean;
  last_saved_ms?: number;
}
interface NativeResult {
  success: boolean;
  error?: string;
  openEditors?: NativeEditor[];
  filePath?: string;
  notFound?: boolean;
}
interface NativeService {
  ensureStarted(): Promise<void>;
  isStarted(): boolean;
  getPort(): string;
  getPreviewUrl(path: string): Promise<string>;
  getEditorStatusByFilePath(path: string): Promise<NativeResult>;
  saveEditor(id: string): Promise<NativeResult>;
  closeEditor(id: string, options?: { force?: boolean }): Promise<NativeResult>;
  dispose(): Promise<void>;
}
interface ResourceManifest {
  schema: number;
  platform: string;
  wrapperVersion: string;
  engineVersion: string;
  binary: string;
  wrapper: string;
  sha256: string;
}

const GIT_LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";

async function assertNativeBinaryAvailable(path: string): Promise<void> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error("Office 本地资源不完整");
  // A Git LFS pointer is a small text file that still passes stat().isFile().
  // Detect it before advertising Office as available so dev checkouts get an
  // actionable setup error instead of a generic hash failure on first open.
  if (info.size <= 1024) {
    const content = await readFile(path, "utf8").catch(() => "");
    if (content.startsWith(GIT_LFS_POINTER_PREFIX)) {
      throw new Error("Office SDK 尚未通过 Git LFS 完整检出，请运行 git lfs pull");
    }
  }
}

/** Server 独占的本地引擎适配器，只加载显式本地资源，不安装或下载 SDK。 */
export class OfficeEngine {
  private native: NativeService | null = null;
  private starting: Promise<void> | null = null;
  private sessionId: string | undefined;
  private requestId = 0;
  private manifest: ResourceManifest | null = null;
  private toolCatalog: OfficeToolDefinition[] | null = null;
  readonly resourceDirectory: string;

  constructor(
    private readonly options: {
      resourceDirectory?: string;
      logDirectory: string;
      onExit?: () => void;
    },
  ) {
    this.resourceDirectory = resolve(
      options.resourceDirectory ??
        process.env.JUGGLEWORK_OFFICE_ENGINE_DIR ??
        fileURLToPath(
          new URL("../../../desktop/resources/office-engine", import.meta.url),
        ),
    );
  }

  /** 检查平台、配套版本和资源是否齐全；不启动引擎。 */
  async capabilities(): Promise<OfficeCapabilities> {
    if (process.env.JUGGLEWORK_OFFICE_ENABLED === "0")
      return { available: false, formats: [], reason: "Office 编辑未启用" };
    try {
      const targetManifest = join(
        this.resourceDirectory,
        `${process.platform}-${process.arch}`,
        "version.json",
      );
      const manifest = JSON.parse(
        await readFile(
          await stat(targetManifest).then(
            () => targetManifest,
            (error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
              return join(this.resourceDirectory, "version.json");
            },
          ),
          "utf8",
        ),
      ) as ResourceManifest;
      if (
        manifest.schema !== 1 ||
        manifest.platform !== `${process.platform}-${process.arch}`
      )
        throw new Error("缺少当前平台的 Office 引擎资源");
      if (
        manifest.engineVersion !== "0.0.0.499" ||
        manifest.wrapperVersion !== "0.2.196-office.1"
      )
        throw new Error("Office 引擎版本尚未适配");
      const marker = await readFile(
        join(
          dirname(join(this.resourceDirectory, manifest.binary)),
          ".editor-sdk-version",
        ),
        "utf8",
      );
      if (marker.trim() !== manifest.engineVersion)
        throw new Error("Office 引擎配套版本不一致");
      await assertNativeBinaryAvailable(
        join(this.resourceDirectory, manifest.binary),
      );
      if (!(await stat(join(this.resourceDirectory, manifest.wrapper))).isFile())
        throw new Error("Office 本地资源不完整");
      this.manifest = manifest;
      return {
        available: true,
        formats: [...OFFICE_EDITABLE_FORMATS],
        engineVersion: manifest.engineVersion,
      };
    } catch (error) {
      return {
        available: false,
        formats: [],
        reason:
          error instanceof Error && !String(error).includes("ENOENT")
            ? error.message
            : "尚未配置本地 Office 引擎",
      };
    }
  }

  /** 首次使用时校验本地文件并启动唯一进程，复用 SDK 的健康检查和实际端口选择。 */
  async ensureStarted(): Promise<void> {
    if (this.native?.isStarted()) return;
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }
  private async start(): Promise<void> {
    const capabilities = await this.capabilities();
    if (!capabilities.available || !this.manifest)
      throw new Error(capabilities.reason);
    const manifest = this.manifest;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(
      join(this.resourceDirectory, manifest.binary),
    ))
      hash.update(chunk);
    if (hash.digest("hex") !== manifest.sha256)
      throw new Error("Office 原生资源校验失败");
    await mkdir(this.options.logDirectory, { recursive: true });
    const require = createRequire(
      join(this.resourceDirectory, "wrapper", "package.json"),
    );
    const { OfficeDocsService } = require(
      join(this.resourceDirectory, manifest.wrapper),
    ) as {
      OfficeDocsService: new (
        options: Record<string, unknown>,
      ) => NativeService;
    };
    // TIPS: 快速重启时，原生 SDK 可能连续绑定固定起点附近的端口失败。
    // 先向系统申请空闲端口，仍由 wrapper 确认启动后的实际端口并处理绑定变化。
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address() as AddressInfo;
        probe.close((error) => (error ? reject(error) : resolve(address.port)));
      });
    });
    const native = new OfficeDocsService({
      port: String(port),
      editorSdkPath: join(this.resourceDirectory, manifest.binary),
      // TIPS: 本地编辑不提供在线业务代理，页面的本地接口不能转发到外部账号或配置服务。
      enableTdProxy: false,
      // TIPS: 安装目录和签名资源只读；SDK 的相对临时文件必须留在用户数据目录。
      editorSdkProcessLauncher: {
        launch: (request: { binaryPath: string; args: readonly string[] }) => {
          const child = spawn(request.binaryPath, [...request.args], {
            cwd: this.options.logDirectory,
            stdio: ["ignore", "pipe", "pipe"],
            detached: false,
          });
          return Object.assign(child, {
            requestStop: () => child.kill("SIGTERM"),
            forceStop: () => child.kill("SIGKILL"),
          });
        },
      },
      logDir: this.options.logDirectory,
      corsOrigins: ["*"],
      logger: { info() {}, warn() {} },
      onUnexpectedExit: () => {
        this.native = null;
        this.sessionId = undefined;
        this.toolCatalog = null;
        this.options.onExit?.();
      },
    });
    this.native = native;
    try {
      await native.ensureStarted();
      if (!native.isStarted()) throw new Error("Office 引擎未就绪");
      await this.rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "jugglework-office", version: "1" },
      });
    } catch (error) {
      await native.dispose();
      this.native = null;
      throw error;
    }
  }

  /** 返回实际启动后的 HTTP MCP 地址，供已有引擎动态同步。 */
  get mcpUrl(): string {
    if (!this.native?.isStarted()) throw new Error("Office 引擎未启动");
    return `http://127.0.0.1:${this.native.getPort()}/mcp`;
  }
  /** 构造对应格式的原生编辑页面，必须由页面先建立模型。 */
  async previewUrl(path: string): Promise<string> {
    await this.ensureStarted();
    return this.native!.getPreviewUrl(path);
  }
  /** 查询指定实际路径的模型及 dirty 状态。 */
  async editor(path: string): Promise<NativeEditor | null> {
    if (!this.native?.isStarted()) return null;
    const result = await this.native.getEditorStatusByFilePath(path);
    if (!result.success)
      throw new Error(result.error ?? "查询 Office 模型失败");
    return (
      result.openEditors?.find((editor) => editor.file_path === path) ?? null
    );
  }
  /** 仅保存已经绑定的模型原文件，不接受替代路径或输出格式。 */
  async save(id: string): Promise<void> {
    const result = await this.native!.saveEditor(id);
    if (!result.success) throw new Error(result.error ?? "Office 保存失败");
    if (!result.filePath) throw new Error("Office 保存结果缺少文件路径");
    if (/\.xlsx$/i.test(result.filePath))
      await finalizeXlsxExport(result.filePath);
  }
  /** 释放模型；force 只用于用户明确放弃修改或已完成保存后的关闭。 */
  async close(id: string, discard = false): Promise<void> {
    if (!this.native) return;
    const result = await this.native.closeEditor(id, { force: discard });
    if (!result.success) throw new Error(result.error ?? "Office 关闭失败");
  }

  /** 宿主及受控内容通道共用原生 HTTP MCP，工具执行失败不伪装成成功。 */
  async tool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await this.ensureStarted();
    const result = await this.rpc("tools/call", { name, arguments: args });
    const texts = Array.isArray(result.content)
      ? result.content.flatMap((entry: { type?: string; text?: string }) =>
          entry.type === "text" && entry.text ? [entry.text] : [],
        )
      : [];
    if (result.isError)
      throw new Error(texts.join("\n") || "Office 工具执行失败");
    for (const text of texts) {
      try {
        const value = JSON.parse(text);
        if (value && typeof value === "object") {
          if (value.code === -1 || value.success === false)
            throw new Error(
              value.message ?? value.error ?? "Office 工具执行失败",
            );
          return value;
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    return result;
  }

  /** 查询并缓存当前引擎的真实工具契约，不把完整目录直接暴露给语言模型。 */
  async listTools(): Promise<readonly OfficeToolDefinition[]> {
    await this.ensureStarted();
    if (this.toolCatalog) return this.toolCatalog;
    const result = await this.rpc("tools/list", {});
    if (
      !Array.isArray(result.tools) ||
      result.tools.some(
        (tool) =>
          !tool ||
          typeof tool.name !== "string" ||
          !tool.inputSchema ||
          typeof tool.inputSchema !== "object",
      )
    )
      throw new Error("Office 工具目录格式无效");
    this.toolCatalog = result.tools;
    return this.toolCatalog!;
  }
  private async rpc(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, any>> {
    const response = await loopbackFetch(this.mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++this.requestId,
        method,
        params,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      throw new Error(`Office MCP 请求失败 (${response.status})`);
    this.sessionId = response.headers.get("mcp-session-id") ?? this.sessionId;
    const raw = await response.text();
    const envelope = JSON.parse(
      raw.trim().startsWith("{")
        ? raw
        : (raw
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6) ?? "{}"),
    );
    if (envelope.error)
      throw new Error(envelope.error.message ?? "Office MCP 请求失败");
    return envelope.result ?? {};
  }

  /** 关闭本 Server 创建的进程，等待启动结束后再释放，避免退出时遗留子进程。 */
  async dispose(): Promise<void> {
    await this.starting?.catch(() => {});
    const native = this.native;
    this.native = null;
    this.sessionId = undefined;
    this.toolCatalog = null;
    await native?.dispose();
  }
}
