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
describe("Chat startup preload", () => {
  test("keeps the Chat surface mounted before its route is opened", () => {
    expect(workspaceRouteSource).toContain("<ChatPage");
    expect(workspaceRouteSource).not.toContain("chatMounted");
    expect(workspaceRouteSource).toContain(
      'className={chatVisible ? "absolute inset-0" : "hidden"}',
    );
  });

  test("keeps the React Chat runtime mounted eagerly", () => {
    expect(workspaceRouteSource).toContain("<ChatPage");
    expect(workspaceRouteSource).toContain("React runtime initializes the IM");
    expect(chatPageSource).toContain("<JuggleChatApp");
    expect(chatPageSource).not.toContain("<iframe");
    expect(chatPageSource).not.toContain("/chat/index.html");
  });
});
