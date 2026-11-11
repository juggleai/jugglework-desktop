import { CloudDocChangesProvider } from "../src/react-app/domains/cloud-docs/cloud-doc-changes-provider";
/** @jsxImportSource react */
import { expect, test } from "bun:test";
import * as React from "react";
import { act, create } from "react-test-renderer";
import { CloudDocsTurnCard } from "../src/react-app/domains/cloud-docs/cloud-docs-turn-card";
import type { JuggleWorkServerClient } from "../src/app/lib/jugglework-server";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

test("会话只批量请求一次；运行中不能撤销，恢复后只撤销所选轮次", async () => {
  const reads: string[] = [];
  const undos: string[] = [];
  let batches = 0;
  const summary = (messageId: string) => ({ messageId, documents: [{ tenantId: "t", workspaceId: "dw", docId: "d", title: messageId, replaced: 1, inserted: 0, deleted: 0 }], undone: undos.includes(messageId) });
  const client = {
    baseUrl: "http://local",
    cloudDocsSessionChanges: async () => { batches++; return { turns: [summary("m1"), summary("m2")] }; },
    cloudDocsChanges: async (_workspace: string, _session: string, messageId: string) => {
      reads.push(messageId);
      return { documents: [{ tenantId: "t", workspaceId: "dw", docId: "d", title: messageId, replaced: 1, inserted: 0, deleted: 0 }], changes: [], undone: undos.includes(messageId) };
    },
    cloudDocsUndo: async (_workspace: string, _session: string, messageId: string) => { undos.push(messageId); return { restored: 1, conflicts: 0 }; },
  } as unknown as JuggleWorkServerClient;
  const cards = (busy: boolean) => <CloudDocChangesProvider client={client} workspaceId="local" sessionId="s" busy={busy}><CloudDocsTurnCard client={client} workspaceId="local" sessionId="s" messageId="m1" busy={busy} /><CloudDocsTurnCard client={client} workspaceId="local" sessionId="s" messageId="m2" busy={busy} /></CloudDocChangesProvider>;
  let renderer!: ReturnType<typeof create>;
  await act(async () => { renderer = create(cards(false)); });
  expect(reads).toEqual([]);
  expect(batches).toBe(1);
  await act(async () => { renderer.update(cards(true)); });
  const first = () => renderer.root.findAll(node => node.type === "button" && typeof node.props.onClick === "function")[1];
  expect(first().props.disabled).toBe(true);
  await act(async () => { first().props.onClick({ preventDefault() {}, nativeEvent: {}, currentTarget: { tagName: "BUTTON" } }); });
  expect(undos).toEqual([]);
  await act(async () => { renderer.update(cards(false)); });
  await act(async () => { first().props.onClick({ preventDefault() {}, nativeEvent: {}, currentTarget: { tagName: "BUTTON" } }); });
  expect(undos).toEqual(["m1"]);
  expect(renderer.root.findAll(node => node.type === "button")).toHaveLength(3);
  await act(async () => { renderer.unmount(); });
});
