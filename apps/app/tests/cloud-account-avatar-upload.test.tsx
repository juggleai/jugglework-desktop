import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import * as den from "../src/app/lib/den";

const baseUrl = "https://den.example";
const authToken = "session";
const client = den.createDenClient({ baseUrl, token: authToken });
const user = { id: "user", name: "Alice", email: "alice@example.org", avatar: null };
const setUser = mock(() => {}), refresh = mock(async () => {});
const writeProfile = mock(() => {}), writeIM = mock(() => {});
let organizationId = "a";
mock.module("../src/app/lib/den", () => ({ ...den,
  readDenSettings: () => ({ baseUrl, authToken, activeOrgId: organizationId }), readDenUserId: () => user.id,
  writeDenIMLoginBootstrap: writeIM,
}));
mock.module("../src/react-app/domains/cloud/den-auth-provider", () => ({
  useDenAuth: () => ({ user, refresh, activeOrganization: { id: organizationId, name: "Team", role: "member" } }),
}));
mock.module("../src/react-app/domains/settings/cloud/cloud-session-provider", () => ({
  useCloudSession: () => ({ user, setUser, client, authToken, baseUrl }),
}));
mock.module("../src/react-app/domains/settings/cloud/local-account-profile", () => ({
  readStoredAccountProfile: () => ({ name: "", avatar: null }), writeStoredAccountProfile: writeProfile,
}));

const { CloudAccountSection } = await import("../src/react-app/domains/settings/cloud/cloud-account-section");
const originalFetch = globalThis.fetch;
const grant = { provider: "qiniu", uploadUrl: "https://up.qiniup.com", key: "key", token: "grant", fileUrl: "https://cdn.example/key", expiresAt: "2099-01-01T00:00:00Z" };
const im = { provider: "juggleim", websocketUrl: "wss://im.test", appKey: "app", imUserId: "user", token: "im-token" };
const file = new File(["image"], "face.png", { type: "image/png" });
const view = () => <CloudAccountSection sessions={[]} orgsBusy={false} orgsError={null} />;
let renderer: ReactTestRenderer;
let calls: string[];
let profileResponse: () => Promise<Response>;
let uploadResponse: () => Promise<Response>;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

beforeEach(async () => {
  organizationId = "a";
  for (const fn of [writeProfile, writeIM, setUser, refresh]) fn.mockClear();
  calls = [];
  uploadResponse = async () => Response.json({ key: grant.key });
  profileResponse = async () => Response.json({ user: { ...user, avatar: grant.fileUrl }, im });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (url: string, init: RequestInit) => {
    if (url.endsWith("/file-upload-credentials")) {
      calls.push("grant");
      expect(JSON.parse(String(init.body))).toEqual({ purpose: "avatar", fileName: "face.png", sizeBytes: 5, contentType: "image/png" });
      return Response.json(grant);
    }
    if (url === grant.uploadUrl + "/") { calls.push("upload"); return uploadResponse(); }
    expect(url).toBe(baseUrl + "/jwork/api/v1/me/profile");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ name: user.name, avatarUrl: grant.fileUrl });
    calls.push("patch");
    return profileResponse();
  } });
  await act(async () => { renderer = create(view()); });
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
});
async function pick() {
  const input = renderer.root.findByType("input");
  await act(async () => { input.props.onChange({ currentTarget: { files: [file], value: "fake-path" } }); });
}
function expectNoProfileWrites() {
  for (const fn of [writeProfile, writeIM, setUser, refresh]) expect(fn).not.toHaveBeenCalled();
}

test("account avatar input persists the verified URL and applies the confirmed user and IM", async () => {
  await pick();
  expect(calls).toEqual(["grant", "upload", "patch"]);
  expect(writeProfile).toHaveBeenCalledWith(user.id, { name: user.name, avatar: grant.fileUrl });
  expect(writeIM).toHaveBeenCalledWith(expect.objectContaining({ token: im.token }), organizationId);
  expect(setUser).toHaveBeenCalledWith(expect.objectContaining({ avatar: grant.fileUrl }));
  expect(refresh).toHaveBeenCalledTimes(1);
});

test("bad receipt or a legacy profile server leaves the old avatar and shows an error", async () => {
  uploadResponse = async () => Response.json({ key: "other" });
  await pick();
  expect(calls).toEqual(["grant", "upload"]);
  expect(JSON.stringify(renderer.toJSON())).toContain("上传回执无效");
  expectNoProfileWrites();
  uploadResponse = async () => Response.json({ key: grant.key });
  profileResponse = async () => Response.json({ user, im });
  await pick();
  expect(JSON.stringify(renderer.toJSON())).toContain("服务器未确认保存新头像");
  expectNoProfileWrites();
});

for (const phase of ["upload", "patch"] as const) {
  test(`switching organization during ${phase} fences late responses even if the transport ignores abort`, async () => {
    let finish!: (r: Response) => void;
    const delayed = () => new Promise<Response>(resolve => { finish = resolve; });
    if (phase === "upload") uploadResponse = delayed; else profileResponse = delayed;
    await pick();
    expect(calls.at(-1)).toBe(phase);
    organizationId = "b";
    await act(async () => renderer.update(view()));
    await act(async () => finish(Response.json(phase === "upload" ? { key: grant.key } : { user: { ...user, avatar: grant.fileUrl }, im })));
    expect(calls.at(-1)).toBe(phase);
    expectNoProfileWrites();
    expect(renderer.root.findByProps({ "aria-label": "更换头像" }).props.disabled).toBe(false);
  });
}
