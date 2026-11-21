/** Identity frozen on the user turn; the renderer only answers when it still matches. */
export type NativeActionScope = { baseUrl: string; userId: string; organizationId: string };

export type NativeReadOp = "product_tasks.list" | "contacts.search" | "chats.search" | "calendar.prepare" | "meeting.prepare" | "im.prepare";

export type NativeActionRequest = {
  requestId: string;
  op: NativeReadOp;
  scope: NativeActionScope;
  params: Record<string, unknown>;
};

export type NativeActionResponse =
  | { requestId: string; ok: true; result: unknown }
  | { requestId: string; ok: false; code: string; error: string };

export type NativeActionsBridge = {
  onRequest(callback: (request: NativeActionRequest) => void): () => void;
  respond(value: NativeActionResponse): void;
};
