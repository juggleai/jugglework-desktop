import { describe, expect, test } from "bun:test";

import { buildClaudeWorkerEnvironment, scrubClaudeSecrets } from "./claude-environment.js";

describe("Claude worker environment", () => {
  test("inherits only the minimal allowlist and required scoped values", () => {
    const environment = buildClaudeWorkerEnvironment({
      inheritedEnv: {
        PATH: "/bin",
        HOME: "/profile",
        NODE_EXTRA_CA_CERTS: "/profile/ca.pem",
        AWS_SECRET_ACCESS_KEY: "must-not-inherit",
        OPENAI_API_KEY: "must-not-inherit",
        JUGGLEWORK_TOKEN: "must-not-inherit",
        RANDOM_PARENT_VALUE: "must-not-inherit",
      },
      workerPath: "/app/worker.js",
      claudeExecutablePath: "/app/claude",
      profileDataDir: "/profile/jugglework/claude-agent",
      claudeConfigDir: "/profile/jugglework/claude-agent/config",
      generationToken: "generation-token",
      credentialEnvironment: { ANTHROPIC_API_KEY: "sk-ant-required" },
    });

    expect(environment).toMatchObject({
      PATH: "/bin",
      HOME: "/profile",
      NODE_EXTRA_CA_CERTS: "/profile/ca.pem",
      CLAUDE_CONFIG_DIR: "/profile/jugglework/claude-agent/config",
      ANTHROPIC_API_KEY: "sk-ant-required",
    });
    for (const name of ["AWS_SECRET_ACCESS_KEY", "OPENAI_API_KEY", "JUGGLEWORK_TOKEN", "RANDOM_PARENT_VALUE"]) {
      expect(environment[name]).toBeUndefined();
    }
  });

  test("passes only an official cloud provider contract and rejects broker extras", () => {
    const bedrock = buildClaudeWorkerEnvironment({
      workerPath: "/app/worker.js",
      claudeExecutablePath: "/app/claude",
      profileDataDir: "/profile/jugglework/claude-agent",
      claudeConfigDir: "/profile/jugglework/claude-agent/config",
      generationToken: "generation-token",
      credentialEnvironment: {
        CLAUDE_CODE_USE_BEDROCK: "1",
        AWS_REGION: "us-east-1",
        AWS_BEARER_TOKEN_BEDROCK: "fixture-only-not-a-real-token",
      },
    });
    expect(bedrock).toMatchObject({ CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-east-1" });
    expect(bedrock.ANTHROPIC_API_KEY).toBeUndefined();

    expect(() => buildClaudeWorkerEnvironment({
      workerPath: "/app/worker.js",
      claudeExecutablePath: "/app/claude",
      profileDataDir: "/profile/jugglework/claude-agent",
      claudeConfigDir: "/profile/jugglework/claude-agent/config",
      generationToken: "generation-token",
      credentialEnvironment: { UNAPPROVED_SECRET: "fixture-only" },
    })).toThrow(/unsupported environment variables/);
  });

  test("scrubs injected, formatted, and bearer secrets from diagnostic text", () => {
    const secret = "exact-secret-canary";
    const output = scrubClaudeSecrets(
      `failed AWS_SECRET_ACCESS_KEY=fixture-visible authorization=Bearer abc.def-ghi ${secret}`,
      [secret],
    );
    expect(output).not.toContain(secret);
    expect(output).not.toContain("sk-ant-visible");
    expect(output).not.toContain("abc.def-ghi");
    expect(output).not.toContain("fixture-visible");
    expect(output).toContain("[REDACTED]");
  });
});
