import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client";

export type LegacyOpencodePart = Part;
export type LegacyOpencodeSession = Session;

export type PlaceholderMessageInfo = {
  id: string;
  sessionID: string;
  role: "assistant" | "user";
  time: {
    created: number;
    completed?: number;
  };
  parentID: string;
  modelID: string;
  providerID: string;
  mode: string;
  agent: string;
  path: {
    cwd: string;
    root: string;
  };
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: {
      read: number;
      write: number;
    };
  };
};

export type PlaceholderAssistantMessage = PlaceholderMessageInfo & {
  role: "assistant";
};

export type MessageInfo = Message | PlaceholderMessageInfo;

export type MessageWithParts = {
  info: MessageInfo;
  parts: LegacyOpencodePart[];
};

export type StepGroupMode = "exploration" | "standalone";

export type MessageGroup =
  | { kind: "text"; part: LegacyOpencodePart; segment: "intent" | "result" }
  | { kind: "steps"; id: string; parts: LegacyOpencodePart[]; segment: "execution"; mode: StepGroupMode };
