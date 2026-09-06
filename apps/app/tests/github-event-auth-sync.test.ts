import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

function readSource(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

// TIPS: 这是 GitHub 事件触发自动化 resolveAuth 的真实生产落点——渲染进程登录后把云端
// session token 转发进 apps/server 的内存，见 apps/server 的 github-event-auth-store.ts
// 和这次改动的 tasks.md 3.1。设备身份（deviceId）不走这条路径——apps/server 自己在本地
// 生成、持久化，见 apps/server 的 automation/device-identity.ts 和 jugglework-server
// design.md 决策 12（这几个事件中继端点已经不再要求远程控制那套 agent token 了）。
// 这个模块（desktop-config-provider.tsx）体量太大、依赖太重（denAuth/
// resolveJuggleWorkConnection/多个 IPC 桥），没有现成的组件级测试基础设施，这里跟
// automation-contract.test.ts 同一套约定——读源码断言关键接线点，而不是从零搭一套 mock
// 才能渲染这个 provider。
describe("GitHub event auth sync (renderer → apps/server)", () => {
  test("the local server client exposes push/clear methods hitting the right endpoint", () => {
    const client = readSource("src/app/lib/jugglework-server.ts");
    expect(client).toContain("pushGithubEventAuth: (input: { cloudBaseUrl: string; cloudToken: string; accountId?: string })");
    expect(client).toContain('"/automations/github-event-auth"');
    expect(client).toMatch(/method: "PUT"[\s\S]{0,200}\/automations\/github-event-auth|\/automations\/github-event-auth"[\s\S]{0,300}method: "PUT"/);
    expect(client).toContain("clearGithubEventAuth: ()");
  });

  test("desktop-config-provider pushes the cloud session through /jwork on sign-in and clears it on sign-out", () => {
    const provider = readSource("src/react-app/domains/cloud/desktop-config-provider.tsx");
    expect(provider).toContain("denControlPlaneBaseUrl");
    expect(provider).toContain('if (denAuth.status !== "signed_in")');
    expect(provider).toContain("client.clearGithubEventAuth()");
    expect(provider).toContain("client.pushGithubEventAuth({ cloudBaseUrl: denControlPlaneBaseUrl(cloudBaseUrl), cloudToken, accountId })");
    // TIPS: 用户在没有 org/团队场景下也要能用——推送前必须真的检查了 token 存在，不能无条件
    // 推一个空字符串上去。
    expect(provider).toMatch(/if \(!cloudToken \|\| !cloudBaseUrl\) return;/);
    // 不该再拉远程控制那套设备身份桥——那条路径已经被移除。
    expect(provider).not.toContain("mintAutomationAgentToken");
  });

  test("denControlPlaneBaseUrl is exported so callers outside den.ts can derive the /jwork control-plane root consistently", () => {
    const den = readSource("src/app/lib/den.ts");
    expect(den).toContain("export function denControlPlaneBaseUrl(baseUrl: string): string {");
    expect(den).toContain("DEN_CONTROL_PLANE_PATH");
  });
});
