import { describe, expect, test } from "bun:test";
import type { AgentContinuationContext, AgentContinuationPreview, AgentRuntimeCatalog } from "@jugglework/types/agent-runtime";
import { readFileSync } from "node:fs";

const pickerSource = readFileSync(new URL("../src/react-app/domains/session/modals/agent-runtime-picker-dialog.tsx", import.meta.url), "utf8");
const continuationSource = readFileSync(new URL("../src/react-app/domains/session/modals/agent-continuation-dialog.tsx", import.meta.url), "utf8");

const catalog: AgentRuntimeCatalog = {
  schemaVersion: 1,
  defaultRuntimeId: "jugglework",
  runtimes: [{
    schemaVersion: 1,
    id: "jugglework",
    engine: "opencode",
    label: "JuggleWork",
    description: "Default runtime",
    isDefault: true,
    capabilities: {
      models: false,
      variants: false,
      "reasoning-stream": false,
      commands: false,
      shell: false,
      compact: false,
      resume: true,
      fork: false,
      steer: false,
      enqueue: false,
      permissions: true,
      questions: true,
      todos: true,
      mcp: false,
      subagents: false,
      "file-checkpointing": false,
      "usage-and-cost": false,
      prewarm: false,
      "resident-session": false,
      "plan-mode": false,
      rewind: false,
      "dynamic-model": false,
      "dynamic-effort": false,
      "dynamic-permission-mode": false,
    },
    health: { status: "healthy", checkedAt: 1, reasonCode: null, message: null },
    models: [],
  }],
};

const context: AgentContinuationContext = {
  summary: "Reviewed summary",
  transcript: [{ sourceMessageId: "message-1", role: "user", text: "Continue this work" }],
};

const preview: AgentContinuationPreview = {
  sourceSessionId: "source",
  sourceTitle: "Source session",
  sourceRuntimeId: "jugglework",
  targetRuntimeId: "claude-agent",
  context,
  omissions: { secretBearingText: 0, oversizedText: 0, attachments: 0, tools: 0, hiddenOrReasoning: 0, pendingInteractions: 0 },
  selectedCharacters: 18,
  maxCharacters: 120_000,
};

describe("agent runtime dialogs accessibility", () => {
  test("names the runtime picker, describes immutable binding, and exposes radio selection", () => {
    expect(catalog.runtimes[0]?.label).toBe("JuggleWork");
    expect(pickerSource).toMatch(/<DialogTitle>Choose Agent Runtime<\/DialogTitle>/);
    expect(pickerSource).toContain("The runtime is permanently bound to this session");
    expect(pickerSource).toMatch(/<RadioGroup[\s\S]+<RadioGroupItem/);
    expect(pickerSource).toMatch(/RadioGroupItem value=\{runtime\.id\} disabled=\{!selectable \|\| props\.loading\}/);
    expect(pickerSource).toMatch(/>Cancel<\/Button>[\s\S]+\{props\.loading \? "Creating\.\.\." : "Create session"\}/);
  });

  test("labels editable migration context, keeps safe action order, and announces errors", () => {
    expect(preview.context).toBe(context);
    expect(continuationSource).toMatch(/<DialogTitle>Continue with Claude Agent<\/DialogTitle>/);
    expect(continuationSource).toContain('aria-label="Migration summary"');
    expect(continuationSource).toContain('aria-label={`${entry.role} migration text ${index + 1}`}');
    expect(continuationSource).toContain('<p role="alert"');
    expect(continuationSource).toMatch(/>Cancel<\/Button>[\s\S]+\{props\.loading \? "Creating linked session\.\.\." : "Continue with Claude"\}/);
    expect(continuationSource).toContain("The source session stays unchanged");
  });
});
