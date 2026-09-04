import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildDesktopAgentProofSigningMessage,
  createRemoteControlCloudClient,
  deriveRemoteControlCloudUrls,
  RemoteControlCloudError,
} from "./remote-control-cloud-client.mjs";
import { createRemoteControlCredentialStore } from "./remote-control-credentials.mjs";

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const KEY_ID = "22222222-2222-4222-8222-222222222222";
const CHALLENGE_ID = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-08-09T12:00:00.000Z";
const FUTURE = "2026-08-09T12:05:00.000Z";
const GRANT = `jwenroll_${Buffer.alloc(32, 7).toString("base64url")}`;
const CHALLENGE = `jwdpop_${Buffer.alloc(32, 8).toString("base64url")}`;
const TOKEN = `jwdagent_${Buffer.alloc(32, 9).toString("base64url")}`;
const CONTEXT = Object.freeze({
  controlPlaneBaseUrl: "https://cloud.example.test",
  userId: "user_1",
  organizationId: "org_1",
});

function jsonResponse(value, status) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function mockSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`safe:${value}`),
    decryptString: (value) => Buffer.from(value).toString().slice("safe:".length),
  };
}

test("derives canonical API, resource, and WSS URLs from all supported control-plane forms", () => {
  const expectedCanonical = {
    controlPlaneBaseUrl: "https://cloud.example.test/jwork/api",
    apiBaseUrl: "https://cloud.example.test/jwork/api",
    resourceUrl: "https://cloud.example.test/jwork/api/desktop-agent/v1",
    webSocketUrl: "wss://cloud.example.test/jwork/api/desktop-agent/v1/connect",
    enrollmentExchangeUrl: "https://cloud.example.test/jwork/api/v1/desktop-devices/enrollment-grants/exchange",
  };
  for (const input of [
    "https://cloud.example.test",
    "https://cloud.example.test/jwork/",
    "https://cloud.example.test/jwork/api",
  ]) assert.deepEqual(deriveRemoteControlCloudUrls(input), expectedCanonical);

  assert.deepEqual(deriveRemoteControlCloudUrls("https://cloud.example.test/api/den/"), {
    controlPlaneBaseUrl: "https://cloud.example.test/api/den",
    apiBaseUrl: "https://cloud.example.test/api/den",
    resourceUrl: "https://cloud.example.test/api/den/desktop-agent/v1",
    webSocketUrl: "wss://cloud.example.test/api/den/desktop-agent/v1/connect",
    enrollmentExchangeUrl: "https://cloud.example.test/api/den/v1/desktop-devices/enrollment-grants/exchange",
  });
});

test("URL derivation rejects credentials, query, fragments, unknown paths, and insecure non-loopback hosts", () => {
  for (const input of [
    "https://user:secret@cloud.example.test",
    "https://cloud.example.test?tenant=x",
    "https://cloud.example.test/#fragment",
    "https://cloud.example.test/custom",
    "http://cloud.example.test",
    "file:///tmp/cloud",
  ]) assert.throws(() => deriveRemoteControlCloudUrls(input), RemoteControlCloudError);

  assert.equal(
    deriveRemoteControlCloudUrls("http://127.0.0.1:8790", { allowInsecureLoopback: true }).webSocketUrl,
    "ws://127.0.0.1:8790/jwork/api/desktop-agent/v1/connect",
  );
});

test("builds the server's exact LF-terminated proof message", () => {
  const resource = "https://cloud.example.test/jwork/api/desktop-agent/v1";
  const message = buildDesktopAgentProofSigningMessage({
    challengeId: CHALLENGE_ID,
    challenge: CHALLENGE,
    deviceId: DEVICE_ID,
    keyId: KEY_ID,
    resource,
  });
  assert.equal(message.toString("utf8"), [
    "jugglework.desktop-agent.pop.v1",
    `challenge_id=${CHALLENGE_ID}`,
    `challenge=${CHALLENGE}`,
    `device_id=${DEVICE_ID}`,
    `key_id=${KEY_ID}`,
    "audience=jugglework-desktop-agent",
    `resource=${resource}`,
    "scopes=desktop-agent:connect",
    "",
  ].join("\n"));
  assert.equal(message.at(-1), 0x0a);
  assert.equal(message.includes(0x0d), false);
});

test("enrollment writes pending credentials before Main exchanges a renderer-created grant", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jugglework-cloud-enrollment-"));
  const filePath = path.join(root, "credentials.json");
  const credentials = createRemoteControlCredentialStore({
    filePath,
    safeStorage: mockSafeStorage(),
    platform: "darwin",
    now: () => new Date(NOW),
  });
  const calls = [];
  const client = createRemoteControlCloudClient({
    controlPlaneBaseUrl: CONTEXT.controlPlaneBaseUrl,
    now: () => new Date(NOW),
    fetcher: async (url, init) => {
      const persistedBeforeFetch = JSON.parse(await readFile(filePath, "utf8"));
      calls.push({ url, init, persistedBeforeFetch });
      const request = JSON.parse(init.body);
      const fingerprint = createHash("sha256").update(Buffer.from(request.credential.publicKey, "base64url")).digest("hex");
      return jsonResponse({
        schemaVersion: 1,
        device: {
          id: DEVICE_ID,
          ownerUserId: CONTEXT.userId,
          organizationId: CONTEXT.organizationId,
          displayName: "Alice's Mac",
          platform: "darwin",
          enrollmentStatus: "enrolled",
          enrolledAt: NOW,
        },
        credential: {
          keyId: KEY_ID,
          algorithm: "Ed25519",
          publicKeyFingerprint: fingerprint,
          createdAt: NOW,
        },
      }, 201);
    },
  });

  const enrolled = await client.enrollDevice({
    credentials,
    context: CONTEXT,
    grant: GRANT,
    displayName: "Alice's Mac",
    platform: "darwin",
  });
  assert.equal(enrolled.state, "enrolled");
  assert.equal(enrolled.deviceId, DEVICE_ID);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].persistedBeforeFetch.state, "pending");
  assert.equal(calls[0].persistedBeforeFetch.grant, undefined);
  assert.equal(calls[0].init.redirect, "error");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    schemaVersion: 1,
    grant: GRANT,
    device: { displayName: "Alice's Mac", platform: "darwin" },
    credential: { algorithm: "Ed25519", publicKey: enrolled.publicKey },
  });
  const finalFile = await readFile(filePath, "utf8");
  assert.equal(finalFile.includes(GRANT), false);
  assert.equal(finalFile.includes(TOKEN), false);
});

test("a failed or mismatched enrollment response keeps the reusable local record pending", async () => {
  const pending = {
    publicKey: Buffer.alloc(32, 4).toString("base64url"),
    publicKeyFingerprint: createHash("sha256").update(Buffer.alloc(32, 4)).digest("hex"),
  };
  let completed = false;
  const credentials = {
    prepareEnrollment: async () => pending,
    completeEnrollment: async () => {
      completed = true;
    },
  };
  const client = createRemoteControlCloudClient({
    controlPlaneBaseUrl: CONTEXT.controlPlaneBaseUrl,
    fetcher: () => Promise.resolve(jsonResponse({
      schemaVersion: 1,
      device: {
        id: DEVICE_ID,
        ownerUserId: "other_user",
        organizationId: CONTEXT.organizationId,
        displayName: "Device",
        platform: "darwin",
        enrollmentStatus: "enrolled",
        enrolledAt: NOW,
      },
      credential: {
        keyId: KEY_ID,
        algorithm: "Ed25519",
        publicKeyFingerprint: pending.publicKeyFingerprint,
        createdAt: NOW,
      },
    }, 201)),
  });
  await assert.rejects(client.enrollDevice({ credentials, context: CONTEXT, grant: GRANT, displayName: "Device", platform: "darwin" }), (error) => {
    assert.ok(error instanceof RemoteControlCloudError);
    assert.equal(error.code, "enrollment_binding_mismatch");
    return true;
  });
  assert.equal(completed, false);
});

test("accepts Go RFC 3339 timestamps without fractional seconds", async () => {
  const publicKey = Buffer.alloc(32, 6);
  const publicKeyFingerprint = createHash("sha256").update(publicKey).digest("hex");
  const credentials = {
    prepareEnrollment: async () => ({ publicKey: publicKey.toString("base64url") }),
    completeEnrollment: async (_context, binding) => binding,
  };
  const client = createRemoteControlCloudClient({
    controlPlaneBaseUrl: CONTEXT.controlPlaneBaseUrl,
    fetcher: () => Promise.resolve(jsonResponse({
      schemaVersion: 1,
      device: {
        id: DEVICE_ID,
        ownerUserId: CONTEXT.userId,
        organizationId: CONTEXT.organizationId,
        displayName: "Device",
        platform: "linux",
        enrollmentStatus: "enrolled",
        enrolledAt: "2026-08-09T12:00:00Z",
      },
      credential: {
        keyId: KEY_ID,
        algorithm: "Ed25519",
        publicKeyFingerprint,
        createdAt: "2026-08-09T12:00:00Z",
      },
    }, 201)),
  });
  assert.equal((await client.enrollDevice({
    credentials,
    context: CONTEXT,
    grant: GRANT,
    displayName: "Device",
    platform: "linux",
  })).enrolledAt, "2026-08-09T12:00:00Z");
});

test("fetches a bound challenge, directly signs exact bytes, and exchanges a canonical Ed25519 proof", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const requests = [];
  const resource = "https://cloud.example.test/jwork/api/desktop-agent/v1";
  const client = createRemoteControlCloudClient({
    controlPlaneBaseUrl: CONTEXT.controlPlaneBaseUrl,
    now: () => new Date(NOW),
    fetcher: async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url, init, body });
      if (url.endsWith("/auth-challenges")) {
        return jsonResponse({
          schemaVersion: 1,
          challengeId: CHALLENGE_ID,
          challenge: CHALLENGE,
          deviceId: DEVICE_ID,
          keyId: KEY_ID,
          audience: "jugglework-desktop-agent",
          resource,
          scopes: ["desktop-agent:connect"],
          expiresAt: FUTURE,
        }, 201);
      }
      const signature = Buffer.from(body.signature, "base64url");
      assert.equal(body.signature, signature.toString("base64url"));
      assert.equal(signature.length, 64);
      assert.equal(verify(null, buildDesktopAgentProofSigningMessage({
        challengeId: CHALLENGE_ID,
        challenge: CHALLENGE,
        deviceId: DEVICE_ID,
        keyId: KEY_ID,
        resource,
      }), publicKey, signature), true);
      return jsonResponse({
        schemaVersion: 1,
        tokenType: "Bearer",
        accessToken: TOKEN,
        deviceId: DEVICE_ID,
        audience: "jugglework-desktop-agent",
        resource,
        scopes: ["desktop-agent:connect"],
        expiresAt: FUTURE,
      }, 200);
    },
  });

  const token = await client.issueAgentToken({
    context: CONTEXT,
    credentials: {
      getSigningCredential: async () => ({ deviceId: DEVICE_ID, keyId: KEY_ID, privateKey }),
    },
  });
  assert.deepEqual(token, {
    accessToken: TOKEN,
    tokenType: "Bearer",
    expiresAt: FUTURE,
    resource,
    webSocketUrl: "wss://cloud.example.test/jwork/api/desktop-agent/v1/connect",
  });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].body, { schemaVersion: 1, keyId: KEY_ID });
  assert.deepEqual(requests[1].body, {
    schemaVersion: 1,
    challengeId: CHALLENGE_ID,
    challenge: CHALLENGE,
    keyId: KEY_ID,
    signature: requests[1].body.signature,
  });
});

test("strict HTTP handling rejects status, content type, malformed JSON, unknown fields, and binding mismatches", async () => {
  const privateKey = generateKeyPairSync("ed25519").privateKey;
  const baseChallenge = {
    schemaVersion: 1,
    challengeId: CHALLENGE_ID,
    challenge: CHALLENGE,
    deviceId: DEVICE_ID,
    keyId: KEY_ID,
    audience: "jugglework-desktop-agent",
    resource: "https://cloud.example.test/jwork/api/desktop-agent/v1",
    scopes: ["desktop-agent:connect"],
    expiresAt: FUTURE,
  };
  const failures = [
    () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    () => new Response("{}", { status: 201, headers: { "content-type": "text/plain" } }),
    () => new Response("{", { status: 201, headers: { "content-type": "application/json" } }),
    () => jsonResponse({ ...baseChallenge, unknown: true }, 201),
    () => jsonResponse({ ...baseChallenge, resource: "https://evil.example.test/desktop-agent/v1" }, 201),
    () => jsonResponse({ ...baseChallenge, challenge: `${CHALLENGE}=` }, 201),
    () => jsonResponse({ ...baseChallenge, expiresAt: NOW }, 201),
    () => jsonResponse({ ...baseChallenge, expiresAt: "2026-02-30T12:00:00Z" }, 201),
  ];
  for (const response of failures) {
    const client = createRemoteControlCloudClient({
      controlPlaneBaseUrl: CONTEXT.controlPlaneBaseUrl,
      now: () => new Date(NOW),
      fetcher: () => Promise.resolve(response()),
    });
    await assert.rejects(client.issueAgentToken({
      context: CONTEXT,
      credentials: { getSigningCredential: async () => ({ deviceId: DEVICE_ID, keyId: KEY_ID, privateKey }) },
    }), RemoteControlCloudError);
  }
});

test("preserves explicit revoked/disabled codes from challenge or token and leaves deletion/not-found ambiguous", async () => {
  const privateKey = generateKeyPairSync("ed25519").privateKey;
  for (const [status, body, expectedCode] of [
    [403, { error: "device_revoked", message: "revoked" }, "device_revoked"],
    [403, { error: "device_disabled", message: "disabled" }, "device_disabled"],
    [401, { error: "device_revoked", message: "wrong status" }, "unexpected_status"],
    [404, { error: "device_deleted", message: "deleted" }, "unexpected_status"],
    [401, { error: "unauthorized", message: "ambiguous" }, "unexpected_status"],
    [404, { error: "not_found", message: "ambiguous" }, "unexpected_status"],
    [500, { error: "device_revoked", message: "not authoritative" }, "unexpected_status"],
  ]) {
    const client = createRemoteControlCloudClient({
      controlPlaneBaseUrl: CONTEXT.controlPlaneBaseUrl,
      now: () => new Date(NOW),
      fetcher: async (url) => url.endsWith("/auth-challenges")
        ? jsonResponse({
            schemaVersion: 1,
            challengeId: CHALLENGE_ID,
            challenge: CHALLENGE,
            deviceId: DEVICE_ID,
            keyId: KEY_ID,
            audience: "jugglework-desktop-agent",
            resource: "https://cloud.example.test/jwork/api/desktop-agent/v1",
            scopes: ["desktop-agent:connect"],
            expiresAt: FUTURE,
          }, 201)
        : jsonResponse(body, status),
    });
    await assert.rejects(client.issueAgentToken({
      context: CONTEXT,
      credentials: { getSigningCredential: async () => ({ deviceId: DEVICE_ID, keyId: KEY_ID, privateKey }) },
    }), (error) => {
      assert.ok(error instanceof RemoteControlCloudError);
      assert.equal(error.code, expectedCode);
      assert.equal(error.status, status);
      return true;
    });
  }
});

test("accepts only the contracted matching-credential status codes at challenge stage", async () => {
  const privateKey = generateKeyPairSync("ed25519").privateKey;
  for (const [status, serverCode, expectedCode] of [
    [403, "device_revoked", "device_revoked"],
    [403, "device_disabled", "device_disabled"],
    [404, "not_found", "unexpected_status"],
    [404, "device_deleted", "unexpected_status"],
  ]) {
    const client = createRemoteControlCloudClient({
      controlPlaneBaseUrl: CONTEXT.controlPlaneBaseUrl,
      fetcher: async () => jsonResponse({ error: serverCode, message: "challenge rejected" }, status),
    });
    await assert.rejects(client.issueAgentToken({
      context: CONTEXT,
      credentials: { getSigningCredential: async () => ({ deviceId: DEVICE_ID, keyId: KEY_ID, privateKey }) },
    }), (error) => {
      assert.ok(error instanceof RemoteControlCloudError);
      assert.equal(error.code, expectedCode);
      assert.equal(error.status, status);
      return true;
    });
  }
});

test("network errors are normalized without exposing grants or tokens in errors", async () => {
  const client = createRemoteControlCloudClient({
    controlPlaneBaseUrl: CONTEXT.controlPlaneBaseUrl,
    fetcher: () => Promise.reject(new Error(`offline ${GRANT} ${TOKEN}`)),
  });
  const credentials = {
    prepareEnrollment: async () => ({ publicKey: Buffer.alloc(32, 5).toString("base64url") }),
    completeEnrollment: async () => assert.fail("must not complete"),
  };
  await assert.rejects(client.enrollDevice({ credentials, context: CONTEXT, grant: GRANT, displayName: "Device", platform: "darwin" }), (error) => {
    assert.ok(error instanceof RemoteControlCloudError);
    assert.equal(error.code, "network_unavailable");
    assert.equal(error.message.includes(GRANT), false);
    assert.equal(error.message.includes(TOKEN), false);
    assert.equal(error.cause, undefined);
    return true;
  });
});
