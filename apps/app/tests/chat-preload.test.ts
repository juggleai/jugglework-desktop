import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workspaceRouteSource = readFileSync(
  new URL("../src/react-app/shell/workspace-app-route.tsx", import.meta.url),
  "utf8",
);
const chatPageSource = readFileSync(
  new URL("../src/react-app/shell/chat-page.tsx", import.meta.url),
  "utf8",
);
const juggleChatAppSource = readFileSync(
  new URL("../src/react-app/domains/jugglechat/jugglechat-app.tsx", import.meta.url),
  "utf8",
);
describe("Chat startup preload", () => {
  test("keeps the Chat surface mounted before its route is opened", () => {
    expect(workspaceRouteSource).toContain("<ChatPage");
    expect(workspaceRouteSource).not.toContain("chatMounted");
    expect(workspaceRouteSource).toContain('? "visible absolute inset-0 z-10 bg-background"');
    expect(workspaceRouteSource).toContain(': "invisible pointer-events-none absolute inset-0 z-0 bg-background"');
  });

  test("keeps the React Chat runtime mounted eagerly", () => {
    expect(workspaceRouteSource).toContain("<ChatPage");
    expect(workspaceRouteSource).toContain("React runtime initializes the IM");
    expect(chatPageSource).toContain("<JuggleChatApp");
    expect(chatPageSource).not.toContain("<iframe");
    expect(chatPageSource).not.toContain("/chat/index.html");
  });

  test("reboots the eager Chat runtime when Den credentials change", () => {
    expect(juggleChatAppSource).toContain("denSettingsChangedEvent");
    expect(juggleChatAppSource).toContain("credentialRevision");
    expect(juggleChatAppSource).toContain("window.addEventListener(denSettingsChangedEvent");
  });
});
