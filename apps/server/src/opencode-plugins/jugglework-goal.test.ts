import { afterEach, describe, expect, test } from "bun:test";
import { GOAL_GUARDRAIL_INSTRUCTION, JuggleWorkGoalPlugin } from "./jugglework-goal.js";

const previous = { url: process.env.JUGGLEWORK_SERVER_URL, token: process.env.JUGGLEWORK_SERVER_TOKEN };
const servers: Array<{ stop: (force?: boolean) => void }> = [];
afterEach(() => {
  while (servers.length) servers.pop()!.stop(true);
  if (previous.url === undefined) delete process.env.JUGGLEWORK_SERVER_URL; else process.env.JUGGLEWORK_SERVER_URL = previous.url;
  if (previous.token === undefined) delete process.env.JUGGLEWORK_SERVER_TOKEN; else process.env.JUGGLEWORK_SERVER_TOKEN = previous.token;
});

function startServer(handler: (path: string, body: unknown) => Response) {
  const calls: Array<{ path: string; auth: string | null; body: unknown }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json() : null;
      calls.push({ path: url.pathname, auth: request.headers.get("authorization"), body });
      if (url.pathname === "/workspaces") {
        return Response.json({ items: [{ id: "ws_a", path: "/work/a" }, { id: "ws_b", path: "/work/a/nested" }] });
      }
      return handler(url.pathname, body);
    },
  });
  servers.push(server);
  process.env.JUGGLEWORK_SERVER_URL = `http://127.0.0.1:${server.port}`;
  process.env.JUGGLEWORK_SERVER_TOKEN = "owt_test";
  return calls;
}

describe("jugglework goal plugin", () => {
  test("exposes the four goal tools", async () => {
    const plugin = await JuggleWorkGoalPlugin();
    expect(Object.keys(plugin.tool).sort()).toEqual([
      "jugglework_goal_blocker", "jugglework_goal_complete", "jugglework_goal_progress", "jugglework_goal_read",
    ]);
  });

  test("tools post the calling session to the workspace that owns the directory", async () => {
    const calls = startServer(() => Response.json({ ok: true, goal: { objective: "x" } }));
    const plugin = await JuggleWorkGoalPlugin();
    const context = { sessionID: "ses_1", directory: "/work/a/nested/pkg" };
    const progress = { criteria: [{ id: "c1", status: "met", evidence: "bun test passed" }], checkpoint: "c1 done, next c2", madeProgress: true };
    expect(JSON.parse(await plugin.tool.jugglework_goal_progress.execute(progress, context))).toMatchObject({ ok: true });
    await plugin.tool.jugglework_goal_read.execute({}, context);
    await plugin.tool.jugglework_goal_blocker.execute({ reason: "need db url", needsUser: true }, context);
    await plugin.tool.jugglework_goal_complete.execute({}, context);
    const goalCalls = calls.filter((call) => call.path !== "/workspaces");
    // The most specific workspace path wins.
    expect(goalCalls.map((call) => call.path)).toEqual([
      "/workspace/ws_b/goal-agent/progress",
      "/workspace/ws_b/goal-agent/read",
      "/workspace/ws_b/goal-agent/blocker",
      "/workspace/ws_b/goal-agent/complete",
    ]);
    expect(goalCalls[0]!.body).toEqual({ sessionId: "ses_1", ...progress });
    expect(goalCalls[2]!.body).toEqual({ sessionId: "ses_1", reason: "need db url", needsUser: true });
    expect(goalCalls.every((call) => call.auth === "Bearer owt_test")).toBe(true);
  });

  test("server rejections are returned to the model instead of thrown", async () => {
    startServer(() => Response.json({ code: "goal_criteria_unmet", message: "Required criteria not met: c2" }, { status: 409 }));
    const plugin = await JuggleWorkGoalPlugin();
    const result = JSON.parse(await plugin.tool.jugglework_goal_complete.execute({}, { sessionID: "ses_1", directory: "/work/a" }));
    expect(result).toEqual({ ok: false, code: "goal_criteria_unmet", message: "Required criteria not met: c2" });
  });

  test("requires the calling session and a JuggleWork-launched engine; validates arguments", async () => {
    startServer(() => Response.json({ ok: true }));
    const plugin = await JuggleWorkGoalPlugin();
    await expect(plugin.tool.jugglework_goal_read.execute({}, { directory: "/work/a" })).rejects.toThrow(/calling session/);
    await expect(plugin.tool.jugglework_goal_blocker.execute({ reason: "", needsUser: false }, { sessionID: "ses_1", directory: "/work/a" })).rejects.toThrow();
    delete process.env.JUGGLEWORK_SERVER_URL;
    await expect(plugin.tool.jugglework_goal_read.execute({}, { sessionID: "ses_1", directory: "/work/a" })).rejects.toThrow(/launched by JuggleWork/);
  });

  test("guardrails are injected only when the session has an unfinished goal", async () => {
    let hasGoal = true;
    startServer(() => Response.json(hasGoal ? { goal: { objective: "x" } } : { goal: null }));
    const plugin = await JuggleWorkGoalPlugin();
    const transform = plugin["experimental.chat.system.transform"];
    const withGoal = { system: ["base"] };
    await transform({ sessionID: "ses_1", directory: "/work/a" }, withGoal);
    expect(withGoal.system).toEqual(["base", GOAL_GUARDRAIL_INSTRUCTION]);
    expect(GOAL_GUARDRAIL_INSTRUCTION).toContain("Never create, edit, pause, resume, or cancel a goal on your own");
    expect(GOAL_GUARDRAIL_INSTRUCTION).toContain("not a goal run");
    expect(GOAL_GUARDRAIL_INSTRUCTION.split("\n").length).toBeGreaterThan(3);

    hasGoal = false;
    const noGoal = { system: ["base"] };
    await transform({ sessionID: "ses_1", directory: "/work/a" }, noGoal);
    expect(noGoal.system).toEqual(["base"]);
    const noSession = { system: ["base"] };
    await transform({ directory: "/work/a" }, noSession);
    expect(noSession.system).toEqual(["base"]);
  });

  test("a server failure never breaks the turn when injecting guardrails", async () => {
    startServer(() => new Response("boom", { status: 500 }));
    const plugin = await JuggleWorkGoalPlugin();
    const output = { system: ["base"] };
    await plugin["experimental.chat.system.transform"]({ sessionID: "ses_1", directory: "/work/a" }, output);
    expect(output.system).toEqual(["base"]);
  });
});
