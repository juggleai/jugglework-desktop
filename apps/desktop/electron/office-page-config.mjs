import { installOfficeSelectionUi } from "./office-selection-ui.mjs";
import { readOfficePageSelection } from "./office-page-selection.mjs";

/**
 * 在 SDK 读取配置前关闭 PPT 内置 AI 编辑入口，普通编辑和宿主内容工具保持原有配置。
 * @param {any} scope 配套 SDK 页面的全局配置对象
 */
function configureSlidePage(scope = window) {
  for (const mode of ["normal", "reading"]) {
    const config = scope.AppConfig?.[mode];
    if (!config) continue;
    config.custom ??= {};
    config.custom.toolbarFileMenu ??= {};
    config.custom.toolbarFileMenu.aiEdit = false;
  }
}

/**
 * 为配套 PPT HTML 添加本地界面配置；仅处理当前引擎的页面，不修改 SDK 文件或其他资源。
 * @param {Request} request 当前资源请求
 * @param {Response} response SDK 返回的原始响应
 * @param {{origin: string, kind: string, selectionUi?: boolean}} host 已绑定页面的来源及文档类型
 */
export async function configureOfficePageResponse(request, response, host) {
  const url = new URL(request.url);
  if (
    (host.kind !== "slide" && !host.selectionUi) ||
    request.method !== "GET" ||
    url.origin !== host.origin ||
    url.pathname !== `/static/${host.kind}/pc.html` ||
    !response.ok ||
    !response.headers.get("content-type")?.includes("text/html")
  )
    return response;

  const html = await response.text();
  const head = /<\/head\s*>/i.exec(html);
  if (!head) throw new Error("PPT 页面配置尚未适配");
  // TIPS: 配套页面先在 head 建立 AppConfig，再在 body 初始化 SDK 配置缓存；dom-ready 时再改已太晚。
  const configure = host.kind === "slide" ? `(${configureSlidePage.toString()})();` : "";
  const selection = host.selectionUi ? `document.addEventListener('DOMContentLoaded',()=>(${installOfficeSelectionUi.toString()})(${JSON.stringify(host.kind)},${readOfficePageSelection.toString()}),{once:true});` : "";
  const script = `<script data-jugglework-office-config>${configure}${selection}</script>`;
  const headers = new Headers(response.headers);
  for (const name of [
    "content-length", "content-encoding", "etag", "content-md5", "digest",
  ])
    headers.delete(name);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(
    html.slice(0, head.index) + script + html.slice(head.index),
    { status: response.status, statusText: response.statusText, headers },
  );
}
