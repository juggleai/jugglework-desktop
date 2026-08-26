import { useCallback, useEffect, useRef, type RefObject } from "react";

import { setCodeCopyButtonState } from "./markdown-primitive";

const CODE_COPY_RESET_DELAY_MS = 2000;

/**
 * 为 Markdown 根节点内的代码块复制按钮绑定统一交互。
 *
 * @param rootRef Markdown 根节点引用
 * @param enabled 是否启用代码块复制
 */
export function useCodeBlockCopy(rootRef: RefObject<HTMLElement | null>, enabled = true): void {
  const resetTimers = useRef(new Map<HTMLButtonElement, number>());

  const copyCode = useCallback(async (button: HTMLButtonElement, code: string) => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      return;
    }

    const previousTimer = resetTimers.current.get(button);
    if (previousTimer !== undefined) window.clearTimeout(previousTimer);
    setCodeCopyButtonState(button, true);

    const resetTimer = window.setTimeout(() => {
      setCodeCopyButtonState(button, false);
      resetTimers.current.delete(button);
    }, CODE_COPY_RESET_DELAY_MS);
    resetTimers.current.set(button, resetTimer);
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !enabled) return;

    const handleClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      const button = event.target.closest("[data-jugglework-code-copy]");
      if (!(button instanceof HTMLButtonElement)) return;

      event.preventDefault();
      event.stopPropagation();
      const code = button.closest("[data-jugglework-code-block]")?.querySelector("code");
      void copyCode(button, code?.textContent ?? "");
    };

    root.addEventListener("click", handleClick);
    return () => root.removeEventListener("click", handleClick);
  }, [copyCode, enabled, rootRef]);

  useEffect(() => {
    const timers = resetTimers.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);
}
