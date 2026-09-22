import { describe, expect, test } from "bun:test";

import { composerDraftToPromptParts } from "../src/react-app/domains/session/sync/composer-prompt-parts";
import {
  connectSkillSlashCommandOptions,
  getSlashCommandQuery,
  isNewSessionCommand,
  parseSlashCommandInvocation,
  skillMenuSlashCommandName,
  skillSlashCommandName,
  withBuiltinSlashCommands,
} from "../src/react-app/domains/session/surface/composer/slash-command";

describe("composer prompt file parts", () => {
  test("keeps path-like prompt text as text unless a file was explicitly attached", async () => {
    for (const text of [
      "帮我添加忽略 /docs/assets/ai-memory/",
      "check ~/code/research/list.csv",
      "check C:\\Users\\omar\\list.csv",
      "check file:///Users/omar/list.csv",
    ]) {
      await expect(composerDraftToPromptParts({
        mode: "prompt",
        text,
        parts: [{ type: "text", text }],
        attachments: [],
      }, "/Users/omar/code/jugglework")).resolves.toEqual([{ type: "text", text }]);
    }
  });

  test("keeps an explicit file mention as a file part", async () => {
    await expect(composerDraftToPromptParts({
      mode: "prompt",
      text: "check @docs/report.md",
      parts: [{ type: "file", path: "docs/report.md" }],
      attachments: [],
    }, "/Users/omar/code/jugglework")).resolves.toEqual([
      { type: "text", text: "check @docs/report.md" },
      {
        type: "file",
        mime: "text/plain",
        url: "file:///Users/omar/code/jugglework/docs/report.md",
        filename: "report.md",
      },
    ]);
  });
});

describe("slash-command parsing", () => {
  test("parses command invocations", () => {
    expect(parseSlashCommandInvocation("/compact")).toEqual({ name: "compact", arguments: "" });
    expect(parseSlashCommandInvocation("/new")).toEqual({ name: "new", arguments: "" });
    expect(parseSlashCommandInvocation("/review this diff")).toEqual({ name: "review", arguments: "this diff" });
  });

  test("does not parse absolute file paths as commands", () => {
    expect(parseSlashCommandInvocation("/Users/omar/code/jugglework/apps/app/src/file.ts\nwhy does this fail?")).toBeNull();
    expect(getSlashCommandQuery("/Users/omar/code/file.ts")).toBeNull();
  });
});

describe("built-in slash commands", () => {
  const builtins = [
    { id: "builtin:new", name: "new", description: "Start a new session.", source: "command" as const },
    { id: "builtin:compact", name: "compact", description: "Reduce context size.", source: "command" as const },
  ];

  test("adds new and compact when the engine command list omits them", () => {
    expect(
      withBuiltinSlashCommands(
        [{ id: "cmd:review", name: "review", source: "command" }],
        builtins,
      ),
    ).toEqual([
      {
        id: "builtin:new",
        name: "new",
        description: "Start a new session.",
        source: "command",
      },
      {
        id: "builtin:compact",
        name: "compact",
        description: "Reduce context size.",
        source: "command",
      },
      { id: "cmd:review", name: "review", source: "command" },
    ]);
  });

  test("preserves engine-provided built-ins without duplication", () => {
    const commands = [
      { id: "cmd:new", name: " NEW ", description: "Engine new", source: "command" as const },
      { id: "cmd:compact", name: " Compact ", description: "Engine compact", source: "command" as const },
    ];

    expect(withBuiltinSlashCommands(commands, builtins)).toBe(commands);
  });

  test("recognizes new as a reserved no-argument interface command", () => {
    expect(isNewSessionCommand({ name: " New ", arguments: "" })).toBe(true);
    expect(isNewSessionCommand({ name: "review", arguments: "new" })).toBe(false);
    expect(() => isNewSessionCommand({ name: "new", arguments: "task title" })).toThrow(
      "/new does not accept arguments.",
    );
  });
});

describe("Connect skill slash commands", () => {
  test("uses the skill trigger and preserves the remote capability identity", () => {
    const [option] = connectSkillSlashCommandOptions([{
      name: "Escalate ticket",
      trigger: "escalate-ticket",
      description: "Prepare a support escalation.",
      path: "jugglework-connect://marketplace_1/plugin_1/skill_1",
      origin: "jugglework-connect",
      marketplaceName: "Team tools",
      pluginName: "Support kit",
      connectCapabilityName: "plugin:plugin_1:skill_1",
    }]);

    expect(option).toMatchObject({
      id: "connect-skill:plugin:plugin_1:skill_1",
      name: "escalate-ticket",
      description: "Prepare a support escalation. — Team tools · Support kit",
      source: "skill",
      skill: {
        connectCapabilityName: "plugin:plugin_1:skill_1",
      },
    });
  });

  test("falls back to a slash-safe slug when a skill has no trigger", () => {
    expect(skillSlashCommandName({ name: "Renewal Playbook" })).toBe("renewal-playbook");
  });

  test("does not normalize local skill labels", () => {
    expect(skillMenuSlashCommandName({
      name: "Local Playbook",
      trigger: "local-playbook",
      origin: "local",
    })).toBe("Local Playbook");
  });

  test("excludes local skills and Connect skills missing a capability identity", () => {
    expect(
      connectSkillSlashCommandOptions([
        {
          name: "Local Playbook",
          trigger: "local-playbook",
          path: "skill://local",
          origin: "local",
          connectCapabilityName: "plugin:plugin_1:skill_1",
        },
        {
          name: "Unresolved",
          trigger: "unresolved",
          path: "jugglework-connect://marketplace_1/plugin_1/skill_2",
          origin: "jugglework-connect",
        },
      ]),
    ).toEqual([]);
  });

  test("falls back to a slug when the trigger contains slash-unsafe characters", () => {
    expect(skillSlashCommandName({ name: "Escalate Ticket", trigger: "escalate ticket" })).toBe("escalate-ticket");
    expect(skillSlashCommandName({ name: "Escalate Ticket", trigger: "skills/escalate" })).toBe("escalate-ticket");
  });

  test("keeps the provenance line usable when the skill has no description", () => {
    const [withProvenance] = connectSkillSlashCommandOptions([{
      name: "Escalate ticket",
      trigger: "escalate-ticket",
      path: "jugglework-connect://marketplace_1/plugin_1/skill_1",
      origin: "jugglework-connect",
      marketplaceName: "Team tools",
      pluginName: "Support kit",
      connectCapabilityName: "plugin:plugin_1:skill_1",
    }]);
    expect(withProvenance?.description).toBe("Team tools · Support kit");

    const [withoutProvenance] = connectSkillSlashCommandOptions([{
      name: "Escalate ticket",
      trigger: "escalate-ticket",
      path: "jugglework-connect://marketplace_1/plugin_1/skill_1",
      origin: "jugglework-connect",
      connectCapabilityName: "plugin:plugin_1:skill_1",
    }]);
    expect(withoutProvenance?.description).toBe("");
  });
});
