import type { NativeActionScope } from "./schema.js";

/**
 * Native-action identity per user turn, frozen when the prompt is submitted.
 *
 * In memory only: after a restart a turn has no scope and its native actions
 * are unavailable, which is the safe outcome. Nothing here is a credential.
 */
export class NativeActionTurns {
  private readonly turns = new Map<string, NativeActionScope | null>();

  constructor(private readonly limit = 500) {}

  private key(workspaceId: string, sessionId: string, messageId: string) {
    return JSON.stringify([workspaceId, sessionId, messageId]);
  }

  /** Records the scope of a submitted turn; a missing scope disables native actions for it. */
  register(workspaceId: string, sessionId: string, messageId: string, scope: NativeActionScope | null | undefined) {
    const key = this.key(workspaceId, sessionId, messageId);
    this.turns.delete(key);
    this.turns.set(key, scope ? structuredClone(scope) : null);
    while (this.turns.size > this.limit) this.turns.delete(this.turns.keys().next().value!);
  }

  get(workspaceId: string, sessionId: string, messageId: string): NativeActionScope | null {
    return this.turns.get(this.key(workspaceId, sessionId, messageId)) ?? null;
  }
}
