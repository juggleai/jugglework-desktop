import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

function readSource(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

// TIPS: 这是 GitHub 事件触发自动化 resolveAuth 的真实生产落点——渲染进程登录后把云端
// session token，以及复用远程控制设备身份铸造出的 agent token，一起转发进 apps/server
// 的内存，见 apps/server 的 github-event-auth-store.ts 和这次改动的 tasks.md 3.1。这个
// 模块（desktop-config-provider.tsx）体量太大、依赖太重（denAuth/resolveJuggleWorkConnection/
// 多个 IPC 桥），没有现成的组件级测试基础设施，这里跟 automation-contract.test.ts 同一套
// 约定——读源码断言关键接线点，而不是从零搭一套 mock 才能渲染这个 provider。
describe("GitHub event auth sync (renderer → apps/server)", () => {
  test("the local server client exposes push/clear methods hitting the right endpoint", () => {
    const client = readSource("src/app/lib/jugglework-server.ts");
    expect(client).toContain('pushGithubEventAuth: (input: { cloudBaseUrl: string; cloudToken: string; agentToken?: string | null })');
    expect(client).toContain('"/automations/github-event-auth"');
    expect(client).toMatch(/method: "PUT"[\s\S]{0,200}\/automations\/github-event-auth|\/automations\/github-event-auth"[\s\S]{0,300}method: "PUT"/);
    expect(client).toContain('clearGithubEventAuth: ()');
  });

  test("desktop-config-provider pushes the cloud session through /jwork on sign-in and clears it on sign-out", () => {
    const provider = readSource("src/react-app/domains/cloud/desktop-config-provider.tsx");
    expect(provider).toContain("denControlPlaneBaseUrl");
    expect(provider).toContain('if (denAuth.status !== "signed_in")');
    expect(provider).toContain("client.clearGithubEventAuth()");
    expect(provider).toContain("cloudBaseUrl: denControlPlaneBaseUrl(cloudBaseUrl)");
    // TIPS: 用户在没有 org/团队场景下也要能用——推送前必须真的检查了 token 存在，不能无条件
    // 推一个空字符串上去。
    expect(provider).toMatch(/if \(!cloudToken \|\| !cloudBaseUrl\) return;/);
  });

  test("the agent-token half reuses remote control's device identity via mintAutomationAgentToken and degrades gracefully when unavailable", () => {
    const provider = readSource("src/react-app/domains/cloud/desktop-config-provider.tsx");
    expect(provider).toContain("mintAutomationAgentToken");
    // Minting is best-effort: a device that never enrolled for remote control
    // (or a mint that fails) must not block pushing the session token itself.
    expect(provider).toContain("const minted = scope ? await mintAutomationAgentToken(scope).catch(() => null) : null;");
    expect(provider).toContain("...(minted ? { agentToken: minted.accessToken } : {})");
  });

  test("the IPC command map declares mintAutomationAgentToken with the remote-control policy scope shape and a nullable result", () => {
    const ipcTypes = readSource("../../packages/types/src/desktop-ipc.ts");
    expect(ipcTypes).toContain("mintAutomationAgentToken: {");
    expect(ipcTypes).toContain("args: [scope: DesktopRemoteControlPolicyScope];");
    expect(ipcTypes).toContain("result: AutomationAgentToken | null;");
  });

  test("the Electron main process mints the agent token by reusing remote control's credential store read-only", () => {
    const issuer = readSource("../desktop/electron/automation-agent-token.mjs");
    expect(issuer).toContain("createRemoteControlCredentialStore");
    expect(issuer).toContain("createRemoteControlCloudClient");
    expect(issuer).toContain("cloudClient.issueAgentToken(");
    // Not enrolled / mint failure both resolve to null, never a thrown error.
    expect(issuer).toMatch(/catch\s*{\s*\n\s*\/\/[\s\S]{0,300}\n\s*return null;/);
  });

  test("denControlPlaneBaseUrl is exported so callers outside den.ts can derive the /jwork control-plane root consistently", () => {
    const den = readSource("src/app/lib/den.ts");
    expect(den).toContain("export function denControlPlaneBaseUrl(baseUrl: string): string {");
    expect(den).toContain("DEN_CONTROL_PLANE_PATH");
  });
});
