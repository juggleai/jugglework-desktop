let mermaidRenderQueue: Promise<void> = Promise.resolve();
let mermaidDiagramId = 0;

const MERMAID_FENCE_PATTERN = /(^|\n)[ \t]{0,3}(`{3,}|~{3,})[ \t]*mermaid(?:[ \t]+[^\n]*)?\n/i;
const MAX_MERMAID_DIAGRAMS = 24;
const MAX_MERMAID_SOURCE_LENGTH = 100_000;

export type MermaidTheme = "default" | "dark";

export type MermaidDiagramMessages = {
  label: string;
  rendering: string;
  error: string;
};

/**
 * 判断 Markdown 是否包含 Mermaid 围栏代码块。
 *
 * @param text Markdown 原文
 */
export function hasMermaidCodeBlock(text: string): boolean {
  return MERMAID_FENCE_PATTERN.test(text);
}

function diagramSource(element: HTMLElement): string | null {
  if (element.matches("pre, [data-jugglework-code-block]")) {
    const code = [...element.querySelectorAll("code")].find((candidate) =>
      [...candidate.classList].some((className) => className.toLowerCase() === "language-mermaid"),
    );
    return code?.textContent ?? null;
  }

  return element.dataset.juggleworkMermaidSource ?? null;
}

function createDiagramContainer(source: string, messages: MermaidDiagramMessages): HTMLDivElement {
  const container = document.createElement("div");
  container.dataset.juggleworkMermaid = "";
  container.dataset.juggleworkMermaidSource = source;
  container.className = "my-4 min-w-0 overflow-x-auto rounded-[18px] border border-dls-border/70 bg-gray-1/50 p-4";
  container.setAttribute("role", "img");
  container.setAttribute("aria-label", messages.label);
  container.textContent = messages.rendering;
  return container;
}

function showDiagramError(container: HTMLElement, source: string, messages: MermaidDiagramMessages): void {
  container.removeAttribute("role");
  container.setAttribute("data-jugglework-mermaid-error", "");
  container.className = "my-4 min-w-0 overflow-x-auto rounded-[18px] border border-destructive/30 bg-destructive/5 p-4";

  const message = document.createElement("p");
  message.className = "mb-3 text-xs text-destructive";
  message.textContent = messages.error;

  const pre = document.createElement("pre");
  pre.className = "m-0 whitespace-pre text-xs leading-6 text-muted-foreground";
  pre.textContent = source;
  container.replaceChildren(message, pre);
}

async function renderDiagram(
  container: HTMLElement,
  source: string,
  theme: MermaidTheme,
  messages: MermaidDiagramMessages,
): Promise<void> {
  const id = `jugglework-mermaid-${Date.now()}-${mermaidDiagramId++}`;

  try {
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme,
    });
    const { svg, bindFunctions } = await mermaid.render(id, source);

    if (!container.isConnected) return;

    // TIPS: Mermaid 在 strict 模式下负责清理标签内容；这里仅挂载库生成的 SVG，
    // 不执行 Markdown 内的原始 HTML 或脚本。
    container.innerHTML = svg;
    bindFunctions?.(container);
  } catch {
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
    if (container.isConnected) showDiagramError(container, source, messages);
  }
}

/**
 * 将 Markdown 预览中的 Mermaid 代码块异步替换为 SVG 图形。
 *
 * @param root Markdown 预览根节点
 * @param theme 当前 Mermaid 主题
 * @param messages 图形状态文案
 */
export function renderMermaidDiagrams(
  root: HTMLElement,
  theme: MermaidTheme,
  messages: MermaidDiagramMessages,
): void {
  const candidates = [
    ...root.querySelectorAll<HTMLElement>("pre, [data-jugglework-code-block], [data-jugglework-mermaid]"),
  ].filter((candidate) => candidate.matches("[data-jugglework-mermaid]") || diagramSource(candidate) !== null);

  for (const [index, candidate] of candidates.entries()) {
    const source = diagramSource(candidate);
    if (!source) continue;

    const container = candidate.matches("[data-jugglework-mermaid]")
      ? candidate
      : createDiagramContainer(source, messages);

    if (container !== candidate) candidate.replaceWith(container);
    container.removeAttribute("data-jugglework-mermaid-error");
    container.setAttribute("aria-label", messages.label);
    container.textContent = messages.rendering;

    if (index >= MAX_MERMAID_DIAGRAMS || source.length > MAX_MERMAID_SOURCE_LENGTH) {
      showDiagramError(container, source, messages);
      continue;
    }

    // TIPS: Mermaid 的 initialize/render 使用全局配置；串行执行可避免同一页面多个
    // 预览并发渲染时，浅色与深色主题配置互相覆盖。
    mermaidRenderQueue = mermaidRenderQueue
      .catch(() => undefined)
      .then(() => renderDiagram(container, source, theme, messages));
  }
}
