/** @jsxImportSource react */
import { useCallback, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import baseCss from "./jugglechat.css?inline";
import bundleCss from "./snailchat-assets/css/bundle.css?inline";
import appCss from "./snailchat-assets/css/app.css?inline";
import customCss from "./snailchat-assets/css/custom.css?inline";
import conversationCss from "./snailchat-assets/css/newui-conversation.css?inline";
import aiCss from "./snailchat-assets/css/newui-ai.css?inline";
import loginCss from "./snailchat-assets/css/newui.css?inline";
import cardBackgroundUrl from "./snailchat-assets/images/card-bg.png";
import bridgeCss from "./snailchat-theme.css?inline";

const sourceCss = [bundleCss, appCss, customCss, conversationCss, aiCss, loginCss]
  .join("\n")
  // :root does not match inside a shadow tree. The reference application's
  // root variables belong on the shadow host in the embedded React version.
  .replaceAll(":root", ":host")
  // The Vue application addresses this source asset from its own /src root.
  // Preserve the same image through Vite's asset URL in the embedded module.
  .replaceAll("/src/assets/images/card-bg.png", cardBackgroundUrl);

export function ChatStyleScope({ children }: { children: ReactNode }) {
  const [shadow, setShadow] = useState<ShadowRoot | null>(null);
  const mount = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    setShadow(node.shadowRoot ?? node.attachShadow({ mode: "open" }));
  }, []);

  return (
    <div ref={mount} className="h-full min-h-0 w-full min-w-0 overflow-hidden">
      {shadow
        ? createPortal(
            <>
              <style>{`:host{display:block;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;container-type:inline-size}`}</style>
              <style>{baseCss}</style>
              <style>{sourceCss}</style>
              <style>{bridgeCss}</style>
              {children}
            </>,
            shadow,
          )
        : null}
    </div>
  );
}
