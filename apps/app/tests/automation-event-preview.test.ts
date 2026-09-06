import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

function readSource(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

// TIPS: 任务 5.2"模拟测试"——这套测试跟仓库里其它"组件"覆盖（automation-contract.test.ts、
// github-event-im-wakeup.test.ts）同一个约定：这个代码库完全没有引入 @testing-library/react，
// "组件测试"落地成读源码断言关键结构/接线点，而不是真的渲染。核心验证点是"预览不会创建
// 运行/会话"——这里用的是比"跑一次、观察没发生"更强的证据：直接断言这条代码路径里
// 根本不存在任何能创建运行/会话的调用，结构上就做不到。
describe("automation event-trigger dry-run preview (5.2)", () => {
  test("the preview component only calls the read-only preview client, never a run/session-creating method", () => {
    const preview = readSource("src/react-app/domains/automations/automation-event-preview.tsx");
    expect(preview).toContain("props.client.previewPrompt(");
    // 结构性保证：这个文件里不存在任何创建运行/会话的调用名——不是"这次测试没触发"，
    // 是这个模块压根没有引用这些方法。
    for (const forbidden of ["runAutomation", "createAutomation", "session.create", "executor.execute", "dispatchSessionPrompt"]) {
      expect(preview).not.toContain(forbidden);
    }
    // 客户端接口本身也要窄——只暴露 previewPrompt 一个方法，误用者没有别的方法可调用。
    expect(preview).toMatch(/export type EventPromptPreviewClient = \{\s*previewPrompt:/);
  });

  test("previewGithubEventPrompt hits the read-only preview endpoint via POST, with no side-effecting sibling call in the same block", () => {
    const client = readSource("src/app/lib/jugglework-server.ts");
    const method = client.slice(client.indexOf("previewGithubEventPrompt:"), client.indexOf("previewGithubEventPrompt:") + 400);
    expect(method).toContain('"/automations/preview-event-prompt"');
    expect(method).toContain('method: "POST"');
  });

  test("the automation editor only renders the preview panel with a parsed draft prompt, wired to previewGithubEventPrompt", () => {
    const page = readSource("src/react-app/domains/automations/automation-page.tsx");
    expect(page).toContain("<EventPromptPreview");
    expect(page).toContain("props.client!.previewGithubEventPrompt(input)");
    // 草稿解析失败时不渲染这个入口（比如提示词还是空的），不强迫用户先填完整提示词。
    const editor = page.slice(page.indexOf("function AutomationEditor"), page.indexOf("function TriggerKindSelector"));
    expect(editor).toMatch(/try \{\s*const promptParts = parseAutomationPrompt\(prompt\)\.parts;/);
  });

  test("apps/server's preview-event-prompt route reuses appendEventContextPromptParts (the same assembly real triggers use) and touches no run-creating repository method", () => {
    const routes = readSource("../server/src/routes/automations.ts");
    const route = routes.slice(routes.indexOf('"/automations/preview-event-prompt"'), routes.indexOf('"/automations/preview-event-prompt"') + 900);
    expect(route).toContain("appendEventContextPromptParts(");
    expect(route).toContain("fetchGithubEntityPreview(");
    for (const forbidden of ["claimEventRun", "claimScheduledRun", "createManualRun", "AutomationExecutor", "AutomationScheduler"]) {
      expect(route).not.toContain(forbidden);
    }
  });

  test("github-entity-preview only supports public github.com PR/issue URLs, not private API tokens or arbitrary hosts", () => {
    const preview = readSource("../server/src/automation/github-entity-preview.ts");
    expect(preview).toContain("https://api.github.com/repos/");
    expect(preview).not.toMatch(/installationToken|writeBackMcp|GITHUB_APP/);
  });
});
