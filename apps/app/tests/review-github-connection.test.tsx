/** @jsxImportSource react */
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";
import type { DenExternalMcpConnection } from "../src/app/lib/den";

const github: DenExternalMcpConnection = {
  id: "org-github", name: "GitHub", url: "https://api.githubcopilot.com/mcp/",
  authType: "oauth", credentialMode: "per_member", connected: false, connectedForMe: false, connectedAt: null,
};
let rows: DenExternalMcpConnection[] = [];
const list = mock(async () => rows);
const openLink = mock((_url: string) => {});
const connected = mock(() => {});
let cloud = {
  baseUrl: "https://work.example.com", authToken: "test", isSignedIn: true,
  activeOrganization: { id: "org-a", role: "member" }, client: { listMcpConnections: list },
};
const org = {
  connections: [] as DenExternalMcpConnection[], error: null as string | null,
  connectingId: null as string | null, refresh: mock(async () => {}), connect: mock(async (_id: string) => {}),
};
mock.module("../src/react-app/kernel/platform", () => ({ usePlatform: () => ({ openLink }) }));
mock.module("../src/react-app/domains/settings/cloud/cloud-session-provider", () => ({ useCloudSession: () => cloud }));
mock.module("../src/react-app/domains/connections/use-org-mcp-connections", () => ({
  useOrgMcpConnections: () => org,
  resolveOrgMcpConnectionCardState: (entry: DenExternalMcpConnection) => ({ connected: (entry.credentialMode === "shared" ? entry.connected : entry.connectedForMe) && !entry.needsReconnect }),
}));
mock.module("../src/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => open ? <section role="dialog">{children}</section> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}));
const { ReviewGitHubConnection, isReviewGitHubConnection, reviewGitHubSetupUrl } = await import("../src/react-app/domains/reviews/review-github-connection");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let view: TestRenderer.ReactTestRenderer | undefined;
const tree = (connectionId?: string) => <ReviewGitHubConnection connectionId={connectionId} onConnected={connected}>{(open) => <button data-testid="open" onClick={open}>Open</button>}</ReviewGitHubConnection>;
async function render(connectionId?: string) { await act(async () => { view = TestRenderer.create(tree(connectionId)); }); }
async function open() { await act(async () => { view!.root.findByProps({ "data-testid": "open" }).props.onClick(); }); }
const output = () => JSON.stringify(view!.toJSON());
async function continueConnecting() {
  await act(async () => {
    view!.root.findAllByType("button").find((button) => button.children.includes("Continue connecting to GitHub"))!.props.onClick();
  });
}
beforeEach(() => {
  rows = []; org.connections = []; org.error = null; org.connectingId = null;
  cloud.activeOrganization = { id: "org-a", role: "member" }; cloud.isSignedIn = true;
  list.mockClear(); openLink.mockClear(); connected.mockClear(); org.connect.mockClear(); org.refresh.mockClear();
});
afterEach(async () => { await act(async () => { view?.unmount(); }); view = undefined; });

describe("Code Review organization GitHub setup", () => {
  test("existing GitHub shows consent and starts authorization only after Continue", async () => {
    rows = [github];
    await render(); await open();
    expect(list).toHaveBeenCalledWith("org-a", "usable");
    expect(output()).toContain("Approved by your organization");
    expect(org.connect).not.toHaveBeenCalled();
    expect(openLink).not.toHaveBeenCalled();
    await continueConnecting();
    expect(org.connect).toHaveBeenCalledWith("org-github");
    expect(openLink).not.toHaveBeenCalled();
    org.connections = [{ ...github, connectedForMe: true }];
    await act(async () => { view!.update(tree()); });
    expect(connected).toHaveBeenCalledTimes(1);
    expect(view!.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
  });

  test("owner connects an existing shared GitHub instead of creating another connector", async () => {
    cloud.activeOrganization.role = "owner";
    rows = [{ ...github, credentialMode: "shared" }];
    await render(); await open();
    expect(org.connect).not.toHaveBeenCalled();
    await continueConnecting();
    expect(org.connect).toHaveBeenCalledWith("org-github");
    expect(openLink).not.toHaveBeenCalled();
  });

  test("member-safe GitHub records without an endpoint still start authorization", async () => {
    rows = [{ ...github, url: "" }];
    await render(); await open();
    expect(org.connect).not.toHaveBeenCalled();
    await continueConnecting();
    expect(org.connect).toHaveBeenCalledWith("org-github");
    expect(openLink).not.toHaveBeenCalled();
  });

  test("review connection ID identifies a renamed or proxied organization connector", async () => {
    rows = [{ ...github, name: "Repository reviews", url: "https://proxy.example.com/mcp" }];
    await render(github.id); await open();
    expect(org.connect).not.toHaveBeenCalled();
    await continueConnecting();
    expect(org.connect).toHaveBeenCalledWith("org-github");
    expect(openLink).not.toHaveBeenCalled();
  });

  test("owner checks managed connectors before treating an empty usable list as missing", async () => {
    cloud.activeOrganization.role = "owner";
    list.mockResolvedValueOnce([]).mockResolvedValueOnce([{ ...github, credentialMode: "shared" }]);
    await render(); await open();
    expect(list).toHaveBeenCalledWith("org-a", "manageable");
    expect(org.connect).not.toHaveBeenCalled();
    await continueConnecting();
    expect(org.connect).toHaveBeenCalledWith("org-github");
    expect(openLink).not.toHaveBeenCalled();
  });

  test.each(["member", "admin"])("missing connector prompts %s to contact the owner", async (role) => {
    cloud.activeOrganization.role = role;
    await render(); await open();
    expect(output()).toContain("Ask your organization owner");
    expect(openLink).not.toHaveBeenCalled();
    expect(org.connect).not.toHaveBeenCalled();
  });

  test("owner opens the correct organization's Add GitHub dialog and resumes when configured", async () => {
    cloud.activeOrganization.role = "owner";
    await render(); await open();
    const url = new URL(openLink.mock.calls[0]![0] as unknown as string);
    expect(url.pathname).toBe("/jwork/console/dashboard/mcp-connections/");
    expect(url.searchParams.get("organizationId")).toBe("org-a");
    expect(url.searchParams.get("quickAdd")).toBe("github");
    expect(url.searchParams.get("flow")).toBe("code-review");
    org.connections = [github];
    await act(async () => { view!.update(tree()); });
    expect(output()).toContain("Continue connecting to GitHub");
    expect(org.connect).not.toHaveBeenCalled();
  });

  test("setup completed in the browser refreshes Code Review", async () => {
    cloud.activeOrganization.role = "owner";
    await render(); await open();
    org.connections = [{ ...github, connectedForMe: true }];
    await act(async () => { view!.update(tree()); });
    expect(connected).toHaveBeenCalledTimes(1);
  });

  test("a failed organization lookup is retryable and never opens setup", async () => {
    list.mockRejectedValueOnce(new Error("offline"));
    await render(); await open();
    expect(output()).toContain("offline"); expect(openLink).not.toHaveBeenCalled();
    rows = [github]; await open(); expect(output()).toContain("Continue connecting to GitHub");
  });

  test("changing organization closes consent and cannot authorize the previous organization", async () => {
    rows = [github]; await render(); await open();
    cloud = { ...cloud, activeOrganization: { id: "org-b", role: "member" } };
    await act(async () => { view!.update(tree()); });
    expect(view!.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    expect(org.connect).not.toHaveBeenCalled();
  });

  test("closing consent never starts browser authorization", async () => {
    rows = [github]; await render(); await open();
    const dialog = view!.root.find((node) => typeof node.props.onOpenChange === "function");
    await act(async () => { dialog.props.onOpenChange(false); });
    expect(view!.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    expect(org.connect).not.toHaveBeenCalled();
    expect(openLink).not.toHaveBeenCalled();
  });

  test("connection identity is endpoint-based and URL carries no credentials", () => {
    expect(isReviewGitHubConnection(github)).toBe(true);
    expect(isReviewGitHubConnection({ url: "https://example.com/github" })).toBe(false);
    expect(isReviewGitHubConnection({ url: "https://api.githubcopilot.com.example.com/mcp/" })).toBe(false);
    expect(reviewGitHubSetupUrl("https://work.example.com", "org/a")).not.toContain("test");
    expect(new URL(reviewGitHubSetupUrl("https://work.example.com", "org/a")).searchParams.get("organizationId")).toBe("org/a");
  });
});
