/**
 * 将内置页面保存请求交给宿主；文件路径由会话固定，页面不能另存到任意路径。
 * @param {Request} request 页面发出的请求
 * @param {{ origin: string, filePath: string, save: () => Promise<{ engineFileId: string | null }> }} host 已绑定文档
 * @returns {Promise<Response | null>} null 表示继续原网络请求
 */
export async function handleOfficeSaveRequest(request, host) {
  const url = new URL(request.url);
  if (url.origin !== host.origin || request.method !== "POST") return null;
  const isSaveApi = url.pathname === "/localapi/save";
  const isMcp = url.pathname === "/mcp";
  const isCloseApi = url.pathname === "/localapi/editor/close";
  if (!isSaveApi && !isMcp && !isCloseApi) return null;
  const body = await request
    .clone()
    .json()
    .catch(() => ({}));
  const tool = isMcp ? body?.params?.name : null;
  if (
    isMcp &&
    tool !== "save_file" &&
    ![
      "open_file",
      "close_file",
      "create_doc",
      "create_sheet",
      "create_slide",
      "shutdown",
    ].includes(tool)
  )
    return null;
  const json = (payload, status = 200) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const fail = (message) =>
    isMcp
      ? json({
          jsonrpc: "2.0",
          id: body.id,
          result: { isError: true, content: [{ type: "text", text: message }] },
        })
      : json({ code: -1, message }, 409);
  if (isCloseApi || (isMcp && tool !== "save_file"))
    return fail("请使用 JuggleWork 的文件打开和关闭操作");
  const args = isMcp ? (body.params?.arguments ?? {}) : body;
  if (
    (args.file_path && args.file_path !== host.filePath) ||
    (args.output_format && args.output_format !== "native")
  )
    return fail("请使用 JuggleWork 的另存为操作导出副本");
  try {
    const document = await host.save();
    const result = {
      code: 0,
      file_id: document.engineFileId,
      file_path: host.filePath,
      message: "saved",
    };
    return isMcp
      ? json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            ...result,
            content: [{ type: "text", text: "File saved successfully" }],
          },
        })
      : json(result);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "文档保存失败");
  }
}

/**
 * 转发页面资源并保留幻灯片原生提交失败；SDK 内部吞掉异常时宿主仍拒绝保存旧模型。
 * @param {Request} request 已绑定页面的请求
 * @param {{origin: string, kind: string, commit: {error: Error | null}, fetch: (request: Request) => Promise<Response>}} host 原生页面及其网络转发
 * @returns {Promise<Response>} 不消耗 SDK 所需的原始响应体
 */
export async function fetchOfficePageResource(request, host) {
  const url = new URL(request.url);
  const commit =
    host.kind === "slide" &&
    url.origin === host.origin &&
    url.pathname === "/localapi/commitrevision" &&
    request.method === "POST";
  try {
    const response = await host.fetch(request);
    if (commit) {
      try {
        const result = await response.clone().json();
        if (!response.ok || result?.code !== 0)
          throw new Error(
            typeof result?.message === "string"
              ? result.message
              : "幻灯片原生提交失败",
          );
      } catch (error) {
        host.commit.error ??=
          error instanceof Error ? error : new Error("幻灯片原生提交失败");
      }
    }
    return response;
  } catch (error) {
    if (commit)
      host.commit.error ??=
        error instanceof Error ? error : new Error("幻灯片提交连接失败");
    throw error;
  }
}
