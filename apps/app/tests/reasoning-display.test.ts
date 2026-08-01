import { describe, expect, test } from "bun:test";

import {
  redactSensitiveCommand,
  redactSensitiveReasoning,
} from "../src/components/chat/reasoning-redaction";
import { DEFAULT_SHOW_THINKING } from "../src/react-app/kernel/local-provider";

// The legacy SessionTranscript markup test was removed with the legacy
// message list (#2016). Reasoning markup for the current transcript is
// covered by the UI evals (evals/) which drive the real app.
describe("reasoning display", () => {
  test("defaults reasoning visibility on", () => {
    expect(DEFAULT_SHOW_THINKING).toBe(true);
  });

  test("hides a local JuggleChat Router curl command", () => {
    const command = "curl -s -m 15 -X POST http://127.0.0.1:17832/router";
    const result = redactSensitiveReasoning(`I will run this command:\n${command}\nThen inspect the result.`);

    expect(result).toContain("[JuggleChat IM operation hidden]");
    expect(result).not.toContain("curl -s");
    expect(result).not.toContain("127.0.0.1");
    expect(result).toContain("Then inspect the result.");
  });

  test("hides the Router command displayed by the bash tool", () => {
    const command = "curl -s -m 15 -X POST http://127.0.0.1:17832/router";
    const displayCommand = redactSensitiveCommand(command);

    expect(displayCommand).toBe("[JuggleChat IM operation hidden]");
    expect(displayCommand).not.toContain("curl");
    expect(displayCommand).not.toContain("17832");
    expect(redactSensitiveCommand("curl https://example.com/health")).toBe(
      "curl https://example.com/health",
    );
  });

  test("hides the entire multiline command inside a fenced block", () => {
    const reasoning = [
      "Calling the IM bridge:",
      "```bash",
      "curl -s -X POST http://localhost:17832/router \\",
      "  -H 'Content-Type: application/json' \\",
      "  -d '{\"method\":\"sendMessage\"}'",
      "```",
      "Waiting for the response.",
    ].join("\n");
    const result = redactSensitiveReasoning(reasoning);

    expect(result).toContain("[JuggleChat IM operation hidden]");
    expect(result).not.toContain("curl");
    expect(result).not.toContain("sendMessage");
    expect(result).not.toContain("17832");
    expect(result).toContain("Waiting for the response.");
  });

  test("leaves unrelated curl commands and normal response text unchanged", () => {
    const regularCurl = "curl https://example.com/health";
    const responseText = "The request completed successfully.";

    expect(redactSensitiveReasoning(regularCurl)).toBe(regularCurl);
    expect(redactSensitiveReasoning(responseText)).toBe(responseText);
  });
});
