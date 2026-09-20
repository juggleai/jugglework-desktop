import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  createHTMLPreviewDocument,
  HTML_PREVIEW_CSP,
  HTMLPreview,
} from "../src/react-app/domains/session/artifacts/preview";

describe("HTML artifact preview isolation", () => {
  test("renders scripts in an opaque-origin sandbox without privileged capabilities", () => {
    const markup = renderToStaticMarkup(
      <HTMLPreview title="hostile.html" content={'<script>parent.window.__JUGGLEWORK_ELECTRON__?.shell.relaunch()</script>'} />,
    );

    expect(markup).toContain('sandbox="allow-scripts"');
    expect(markup).not.toContain("allow-same-origin");
    expect(markup).not.toContain("allow-forms");
    expect(markup).not.toContain("allow-popups");
    expect(markup).not.toContain("allow-top-navigation");
    expect(markup).not.toContain(" src=");
    expect(markup).toContain('referrerPolicy="no-referrer"');
  });

  test("injects the restrictive policy before untrusted artifact content", () => {
    const hostileContent = '<script src="https://attacker.invalid/exfiltrate.js"></script>';
    const document = createHTMLPreviewDocument(hostileContent);

    expect(document.indexOf("Content-Security-Policy")).toBeGreaterThanOrEqual(0);
    expect(document.indexOf("Content-Security-Policy")).toBeLessThan(document.indexOf(hostileContent));
    expect(document).toContain('<meta name="referrer" content="no-referrer">');
    expect(document).toEndWith(hostileContent);
  });

  test("denies network, parent navigation, forms, frames, objects, and workers", () => {
    for (const directive of [
      "default-src 'none'",
      "base-uri 'none'",
      "connect-src 'none'",
      "form-action 'none'",
      "frame-src 'none'",
      "object-src 'none'",
      "worker-src 'none'",
      "navigate-to 'none'",
    ]) {
      expect(HTML_PREVIEW_CSP).toContain(directive);
    }

    expect(HTML_PREVIEW_CSP).toContain("script-src 'unsafe-inline' blob:");
    expect(HTML_PREVIEW_CSP).not.toContain("'unsafe-eval'");
    expect(HTML_PREVIEW_CSP).not.toContain("http:");
    expect(HTML_PREVIEW_CSP).not.toContain("https:");
    expect(HTML_PREVIEW_CSP).not.toContain("ws:");
    expect(HTML_PREVIEW_CSP).not.toContain("wss:");
  });
});
