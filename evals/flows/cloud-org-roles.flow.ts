import { defineFlow, type FlowContext } from "../runner/flow.ts";
import { loadVoiceoverParagraphs } from "../runner/voiceover.ts";

const FLOW_ID = "cloud-org-roles";

// Narration is loaded from the approved script (evals/voiceovers/cloud-org-roles.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs(FLOW_ID);
if (!vo) throw new Error(`Missing approved voice-over script for ${FLOW_ID}.`);

/**
 * Proves the three-role organization model against jugglework-server:
 * `owner`, `admin`, `member`. `super-admin` was merged into `admin`, so the
 * only capabilities left to the owner alone are creating an organization,
 * deleting one, and transferring ownership.
 *
 * The flow only touches endpoints jugglework-server actually implements. It
 * therefore does not exercise invitations, member deletion, ownership
 * transfer, or `PATCH /v1/org`; Frame 3 asserts that the admin's Settings
 * controls are enabled rather than saving through them.
 *
 * `JUGGLEWORK_EVAL_SERVER_URL` is one jugglework-server origin: it serves the
 * API under `/jwork/api` and the static console under `/jwork/console`. The
 * owner credentials are the bootstrap owner from `conf/config.yml`.
 */

type ApiRequestOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

type ApiResult = {
  response: Response;
  body: unknown;
  text: string;
};

type JsonObject = Record<string, unknown>;

type FixtureActor = {
  account: string;
  password: string;
  role: "admin" | "member";
};

type OrgMember = {
  id: string;
  account: string;
  name: string;
  role: string;
  isOwner: boolean;
};

type OrgRole = {
  id: string;
  role: string;
  protected: boolean;
};

type OrgContext = {
  organization: { id: string; name: string; slug: string };
  currentMember: { id: string; role: string; isOwner: boolean };
  members: OrgMember[];
  roles: OrgRole[];
};

type FlowState = {
  prepared: boolean;
  orgId: string | null;
  orgSlug: string | null;
  orgName: string | null;
  adminMemberId: string | null;
  memberMemberId: string | null;
};

const SERVER_URL = cleanBaseUrl(process.env.JUGGLEWORK_EVAL_SERVER_URL);
const API_BASE = `${SERVER_URL}/jwork/api`;
const CONSOLE_BASE = `${SERVER_URL}/jwork/console`;

const OWNER_ACCOUNT = process.env.JUGGLEWORK_EVAL_ORG_ROLES_OWNER_ACCOUNT?.trim() || "owner";
const OWNER_PASSWORD = process.env.JUGGLEWORK_EVAL_ORG_ROLES_OWNER_PASSWORD?.trim() || "";
const DEFAULT_FIXTURE_PASSWORD = process.env.JUGGLEWORK_EVAL_ORG_ROLES_PASSWORD?.trim() || "JuggleWorkDemo123!";

const ADMIN: FixtureActor = {
  account: process.env.JUGGLEWORK_EVAL_ORG_ROLES_ADMIN_ACCOUNT?.trim() || "riley.admin.org-roles",
  password: process.env.JUGGLEWORK_EVAL_ORG_ROLES_ADMIN_PASSWORD?.trim() || DEFAULT_FIXTURE_PASSWORD,
  role: "admin",
};

const MEMBER: FixtureActor = {
  account: process.env.JUGGLEWORK_EVAL_ORG_ROLES_MEMBER_ACCOUNT?.trim() || "morgan.member.org-roles",
  password: process.env.JUGGLEWORK_EVAL_ORG_ROLES_MEMBER_PASSWORD?.trim() || DEFAULT_FIXTURE_PASSWORD,
  role: "member",
};

// The owner-only creation check reuses one deterministic organization so
// repeated runs do not walk the deployment into its ownership limit.
const OWNER_CHECK_ORG_NAME = process.env.JUGGLEWORK_EVAL_ORG_ROLES_CHECK_ORG_NAME?.trim() || "Cloud Org Roles Eval — owner check";

const tokenByAccount = new Map<string, string>();
const state: FlowState = {
  prepared: false,
  orgId: null,
  orgSlug: null,
  orgName: null,
  adminMemberId: null,
  memberMemberId: null,
};

const SIDEBAR_TOP_LEVEL = ["Dashboard", "Extensions", "Models", "Members", "Analytics", "Settings"];
const EXTENSIONS_CHILDREN = ["Marketplace", "Sources", "Plugins", "Connectors"];
const MODELS_CHILDREN = ["LLM Providers"];
const SETTINGS_CHILDREN = ["General", "Diagnostics", "Brand appearance", "Desktop Policies", "Stripe", "API Keys", "SSO", "SCIM"];

const EVAL_ROLE_NAME = "org-roles-eval-reviewer";
const SETTINGS_READ_ONLY_NOTICE = "Read-only: only workspace owners and admins can change settings.";
const ROLES_MANAGE_NOTICE = "Default roles stay available, and owners or admins can add, edit, or remove custom roles here.";

export default defineFlow({
  id: FLOW_ID,
  title: "Cloud organization roles: owner, admin, and member see the right console controls and API permissions",
  kind: "user-facing",
  spec: "evals/voiceovers/cloud-org-roles.md",
  requiredEnv: ["JUGGLEWORK_EVAL_SERVER_URL", "JUGGLEWORK_EVAL_ORG_ROLES_OWNER_PASSWORD"],
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("The console sidebar groups workspace areas into Extensions, Models, Members, Analytics, and Settings", {
          voiceover: vo[0],
          action: async () => {
            await ensureFixturePrepared(ctx);
            await signInToConsole(ctx, OWNER_ACCOUNT, OWNER_PASSWORD);
            await goToConsole(ctx, "/dashboard/marketplaces");
            const extensions = await visibleSidebarChildren(ctx);
            await goToConsole(ctx, "/dashboard/custom-llm-providers");
            const models = await visibleSidebarChildren(ctx);
            await goToConsole(ctx, "/dashboard/org-settings");
            const settings = await visibleSidebarChildren(ctx);
            ctx.output("sidebar-group-labels", JSON.stringify({ extensions, models, settings }, null, 2));
          },
          assert: async () => {
            const navText = await getNavText(ctx);
            for (const label of SIDEBAR_TOP_LEVEL) {
              ctx.assert(navText.includes(label), `Sidebar top-level label missing: ${label}`);
            }
            assertStringListIncludes(ctx, await visibleSidebarChildren(ctx), SETTINGS_CHILDREN, "Settings sidebar children");

            await goToConsole(ctx, "/dashboard/marketplaces");
            assertStringListIncludes(ctx, await visibleSidebarChildren(ctx), EXTENSIONS_CHILDREN, "Extensions sidebar children");
            await goToConsole(ctx, "/dashboard/custom-llm-providers");
            assertStringListIncludes(ctx, await visibleSidebarChildren(ctx), MODELS_CHILDREN, "Models sidebar children");
            await goToConsole(ctx, "/dashboard/org-settings");
          },
          screenshot: {
            name: "sidebar-role-groups",
            claim: "The sidebar groups Settings, Extensions, and Models for an organization administrator.",
            requireText: ["Extensions", "Models", "Members", "Analytics", "Settings", "General", "Diagnostics", "Brand appearance", "Desktop Policies", "Stripe", "API Keys", "SSO", "SCIM"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("An admin changes member roles and manages custom roles, with no tier left between admin and owner", {
          voiceover: vo[1],
          action: async () => {
            await ensureFixturePrepared(ctx);
            await signInToConsole(ctx, ADMIN.account, ADMIN.password);
            await openMembersTab(ctx);
            await openMemberActions(ctx, MEMBER.account);
          },
          assert: async () => {
            // The role editor is the control an admin never used to see.
            await ctx.expectText("Edit role", { timeoutMs: 20_000 });

            const adminToken = await tokenForActor(ctx, ADMIN.account, ADMIN.password);
            await removeLeftoverRole(ctx, adminToken, EVAL_ROLE_NAME);
            const memberId = requireStateString(state.memberMemberId, "member id");
            const promote = await updateMemberRoleApi(adminToken, memberId, "admin");
            ctx.assert(promote.response.ok, `Admin should be able to change a member role, saw ${promote.response.status}: ${promote.text.slice(0, 240)}`);
            const restore = await updateMemberRoleApi(adminToken, memberId, "member");
            ctx.assert(restore.response.ok, `Restoring the member role failed with ${restore.response.status}.`);

            const created = await apiFetch("/v1/roles", {
              method: "POST",
              headers: { authorization: `Bearer ${adminToken}` },
              body: JSON.stringify({ roleName: EVAL_ROLE_NAME, permission: { member: ["update"] } }),
            });
            ctx.assert(created.response.status === 201, `Admin should be able to create a custom role, saw ${created.response.status}: ${created.text.slice(0, 240)}`);
            const createdRole = isRecord(created.body) ? recordField(created.body, "role") : null;
            const createdRoleId = createdRole ? stringField(createdRole, "id") : null;
            ctx.assert(Boolean(createdRoleId), "Custom role response did not include an id.");

            const deleted = await apiFetch(`/v1/roles/${encodeURIComponent(createdRoleId ?? "")}`, {
              method: "DELETE",
              headers: { authorization: `Bearer ${adminToken}` },
            });
            ctx.assert(deleted.response.status === 204, `Admin should be able to delete the custom role, saw ${deleted.response.status}.`);

            // The built-in set is exactly owner, admin, member.
            const roles = await apiFetch("/v1/roles", { headers: { authorization: `Bearer ${adminToken}` } });
            const builtIn = parseRoles(roles.body).filter((role) => role.protected).map((role) => role.role);
            ctx.assert(
              builtIn.length === 3 && builtIn.includes("owner") && builtIn.includes("admin") && builtIn.includes("member"),
              `Built-in roles should be owner, admin, member; saw ${JSON.stringify(builtIn)}.`,
            );

            ctx.output("admin-role-management", JSON.stringify({
              promoteStatus: promote.response.status,
              restoreStatus: restore.response.status,
              createRoleStatus: created.response.status,
              deleteRoleStatus: deleted.response.status,
              builtInRoles: builtIn,
            }, null, 2));

            await openMembersTab(ctx);
            await openRolesTab(ctx);
            await ctx.expectText(ROLES_MANAGE_NOTICE, { timeoutMs: 20_000 });
          },
          screenshot: {
            name: "admin-manages-roles",
            claim: "The admin sees the custom-role management copy instead of the read-only role notice.",
            requireText: ["Roles", "Owner", "Admin", "Member"],
            rejectText: ["Role definitions are visible here, but only owners and admins can change them.", "Super Admin", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("Settings controls are enabled for an admin, and the read-only notice is gone", {
          voiceover: vo[2],
          action: async () => {
            await ensureFixturePrepared(ctx);
            await signInToConsole(ctx, ADMIN.account, ADMIN.password);
            await goToConsole(ctx, "/dashboard/org-settings");
            await ctx.expectText("Organization Identity", { timeoutMs: 30_000 });
          },
          assert: async () => {
            const controls = await readGeneralSettingsControlState(ctx);
            ctx.assert(!controls.nameInputDisabled, "The organization name input should be enabled for an admin.");
            ctx.assert(!controls.saveButtonDisabled, "Save settings should be enabled for an admin.");
            await ctx.expectNoText(SETTINGS_READ_ONLY_NOTICE);
            ctx.output("admin-settings-controls", JSON.stringify(controls, null, 2));
          },
          screenshot: {
            name: "admin-settings-writable",
            claim: "The admin sees enabled Settings controls with no read-only explanation.",
            requireText: ["Organization Identity", "Save settings"],
            rejectText: [SETTINGS_READ_ONLY_NOTICE, "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("A plain member loses the administrative sidebar and is rejected by the member, role, and role-change APIs", {
          voiceover: vo[3],
          action: async () => {
            await ensureFixturePrepared(ctx);
            await signInToConsole(ctx, MEMBER.account, MEMBER.password);
            await goToConsole(ctx, "/dashboard");
          },
          assert: async () => {
            const navText = await getNavText(ctx);
            for (const label of ["Members", "Analytics", "Settings"]) {
              ctx.assert(!navText.includes(label), `Sidebar should hide ${label} from a plain member; saw ${JSON.stringify(navText)}.`);
            }

            const memberToken = await tokenForActor(ctx, MEMBER.account, MEMBER.password);
            const createMember = await apiFetch("/v1/members", {
              method: "POST",
              headers: { authorization: `Bearer ${memberToken}` },
              body: JSON.stringify({ account: "org-roles-eval-denied", password: DEFAULT_FIXTURE_PASSWORD, role: "member" }),
            });
            ctx.assert(createMember.response.status === 403, `Member create should be denied, saw ${createMember.response.status}.`);

            const createRole = await apiFetch("/v1/roles", {
              method: "POST",
              headers: { authorization: `Bearer ${memberToken}` },
              body: JSON.stringify({ roleName: "org-roles-eval-denied", permission: {} }),
            });
            ctx.assert(createRole.response.status === 403, `Role create should be denied, saw ${createRole.response.status}.`);

            const roleChange = await updateMemberRoleApi(memberToken, requireStateString(state.adminMemberId, "admin member id"), "member");
            ctx.assert(roleChange.response.status === 403, `Role change should be denied, saw ${roleChange.response.status}.`);

            ctx.output("member-denials", JSON.stringify({
              createMemberStatus: createMember.response.status,
              createRoleStatus: createRole.response.status,
              roleChangeStatus: roleChange.response.status,
            }, null, 2));
          },
          screenshot: {
            name: "member-without-administration",
            claim: "The member's sidebar exposes no Members, Analytics, or Settings entry.",
            requireText: ["Dashboard"],
            rejectText: ["Analytics", "Add member", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        await ctx.prove("Only the owner can create an organization; the same request from an admin is refused", {
          voiceover: vo[4],
          action: async () => {
            await ensureFixturePrepared(ctx);
            await signInToConsole(ctx, OWNER_ACCOUNT, OWNER_PASSWORD);
            await goToConsole(ctx, "/dashboard/members");
          },
          assert: async () => {
            const adminToken = await tokenForActor(ctx, ADMIN.account, ADMIN.password);
            const adminAttempt = await apiFetch("/v1/org", {
              method: "POST",
              headers: { authorization: `Bearer ${adminToken}` },
              body: JSON.stringify({ name: `${OWNER_CHECK_ORG_NAME} (admin attempt)` }),
            });
            ctx.assert(adminAttempt.response.status === 403, `Admin organization creation should be denied with 403, saw ${adminAttempt.response.status}: ${adminAttempt.text.slice(0, 240)}`);
            const adminError = isRecord(adminAttempt.body) ? stringField(adminAttempt.body, "error") : null;
            ctx.assert(adminError === "organization_owner_required", `Expected organization_owner_required, saw ${adminError ?? "none"}.`);

            const ownerToken = await tokenForActor(ctx, OWNER_ACCOUNT, OWNER_PASSWORD);
            const existing = await findOwnedOrganization(ctx, ownerToken, OWNER_CHECK_ORG_NAME);
            let ownerCreateStatus: number | "reused" = "reused";
            if (!existing) {
              const ownerAttempt = await apiFetch("/v1/org", {
                method: "POST",
                headers: { authorization: `Bearer ${ownerToken}` },
                body: JSON.stringify({ name: OWNER_CHECK_ORG_NAME }),
              });
              ctx.assert(ownerAttempt.response.status === 201, `Owner organization creation should succeed, saw ${ownerAttempt.response.status}: ${ownerAttempt.text.slice(0, 240)}`);
              ownerCreateStatus = ownerAttempt.response.status;
              // Creating an organization makes it the session's active one.
              await setActiveOrganization(ctx, ownerToken, requireStateString(state.orgId, "fixture organization id"));
            }

            ctx.output("organization-creation-gate", JSON.stringify({
              adminStatus: adminAttempt.response.status,
              adminError,
              ownerStatus: ownerCreateStatus,
              ownerCheckOrganization: OWNER_CHECK_ORG_NAME,
            }, null, 2));
          },
          screenshot: {
            name: "owner-only-organization-creation",
            claim: "The owner stays on the fixture organization while the admin's creation attempt is refused by the API.",
            requireText: ["Members"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
  ],
});

function cleanBaseUrl(value: string | undefined): string {
  return (value ?? "").trim().replace(/\/+$/, "");
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: JsonObject, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function booleanField(record: JsonObject, key: string): boolean {
  return record[key] === true;
}

function recordField(record: JsonObject, key: string): JsonObject | null {
  const value = record[key];
  return isRecord(value) ? value : null;
}

function arrayField(record: JsonObject, key: string): unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function requireStateString(value: string | null, label: string): string {
  if (value) return value;
  throw new Error(`${label} was not prepared.`);
}

async function apiFetch(pathname: string, options: ApiRequestOptions = {}): Promise<ApiResult> {
  const response = await fetch(`${API_BASE}${pathname}`, {
    method: options.method ?? "GET",
    headers: {
      "content-type": "application/json",
      origin: SERVER_URL,
      ...(options.headers ?? {}),
    },
    body: options.body,
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body, text };
}

async function tokenForActor(ctx: FlowContext, account: string, password: string): Promise<string> {
  const cached = tokenByAccount.get(account);
  if (cached) return cached;
  const result = await apiFetch("/auth/sign-in/account", {
    method: "POST",
    body: JSON.stringify({ account, password }),
  });
  ctx.assert(result.response.ok, `Could not sign in ${account}: ${result.response.status} ${result.text.slice(0, 240)}`);
  const token = isRecord(result.body) ? stringField(result.body, "token") : null;
  ctx.assert(Boolean(token), `Sign-in for ${account} did not return a token.`);
  tokenByAccount.set(account, token ?? "");
  return token ?? "";
}

async function setActiveOrganization(ctx: FlowContext, token: string, organizationId: string): Promise<void> {
  const result = await apiFetch("/v1/me/active-organization", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ organizationId }),
  });
  ctx.assert(result.response.ok, `Could not activate organization ${organizationId}: ${result.response.status}.`);
}

function parseMember(value: unknown): OrgMember | null {
  if (!isRecord(value)) return null;
  const id = stringField(value, "id");
  const role = stringField(value, "role");
  const user = recordField(value, "user");
  if (!id || !role || !user) return null;
  return {
    id,
    account: stringField(user, "account") ?? "",
    name: stringField(user, "name") ?? "",
    role,
    isOwner: booleanField(value, "isOwner"),
  };
}

function parseRoles(payload: unknown): OrgRole[] {
  if (!isRecord(payload)) return [];
  return arrayField(payload, "roles").flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const id = stringField(entry, "id");
    const role = stringField(entry, "role");
    if (!id || !role) return [];
    return [{ id, role, protected: booleanField(entry, "protected") }];
  });
}

async function fetchOrgContext(ctx: FlowContext, token: string): Promise<OrgContext> {
  const result = await apiFetch("/v1/org", { headers: { authorization: `Bearer ${token}` } });
  ctx.assert(result.response.ok, `/v1/org failed: ${result.response.status} ${result.text.slice(0, 240)}`);
  ctx.assert(isRecord(result.body), "/v1/org did not return an object.");
  const body = isRecord(result.body) ? result.body : {};
  const organization = recordField(body, "organization") ?? {};
  const currentMember = recordField(body, "currentMember") ?? {};
  return {
    organization: {
      id: stringField(organization, "id") ?? "",
      name: stringField(organization, "name") ?? "",
      slug: stringField(organization, "slug") ?? "",
    },
    currentMember: {
      id: stringField(currentMember, "id") ?? "",
      role: stringField(currentMember, "role") ?? "",
      isOwner: booleanField(currentMember, "isOwner"),
    },
    members: arrayField(body, "members").map(parseMember).filter((entry): entry is OrgMember => entry !== null),
    roles: parseRoles(body),
  };
}

async function findOwnedOrganization(ctx: FlowContext, token: string, name: string): Promise<string | null> {
  const result = await apiFetch("/v1/me/orgs", { headers: { authorization: `Bearer ${token}` } });
  ctx.assert(result.response.ok, `/v1/me/orgs failed: ${result.response.status}.`);
  if (!isRecord(result.body)) return null;
  for (const entry of arrayField(result.body, "orgs")) {
    if (!isRecord(entry)) continue;
    if (stringField(entry, "name") === name && stringField(entry, "role") === "owner") {
      return stringField(entry, "id");
    }
  }
  return null;
}

// A run that died mid-frame can leave the custom role behind, which would turn
// the next create into a 409.
async function removeLeftoverRole(ctx: FlowContext, token: string, roleName: string): Promise<void> {
  const result = await apiFetch("/v1/roles", { headers: { authorization: `Bearer ${token}` } });
  if (!result.response.ok) return;
  for (const role of parseRoles(result.body)) {
    if (role.role !== roleName || role.protected) continue;
    const deleted = await apiFetch(`/v1/roles/${encodeURIComponent(role.id)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    ctx.assert(deleted.response.status === 204, `Could not clear the leftover ${roleName} role: ${deleted.response.status}.`);
  }
}

async function updateMemberRoleApi(token: string, memberId: string, role: string): Promise<ApiResult> {
  return apiFetch(`/v1/members/${encodeURIComponent(memberId)}/role`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ role }),
  });
}

function findMemberByAccount(context: OrgContext, account: string): OrgMember | null {
  const normalized = account.toLowerCase();
  return context.members.find((member) => member.account.toLowerCase() === normalized) ?? null;
}

async function ensureActor(ctx: FlowContext, ownerToken: string, actor: FixtureActor): Promise<OrgMember> {
  let context = await fetchOrgContext(ctx, ownerToken);
  let member = findMemberByAccount(context, actor.account);

  if (!member) {
    const created = await apiFetch("/v1/members", {
      method: "POST",
      headers: { authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ account: actor.account, password: actor.password, role: actor.role }),
    });
    ctx.assert(
      created.response.status === 201,
      `Could not create the ${actor.role} fixture account ${actor.account}: ${created.response.status} ${created.text.slice(0, 240)}. ` +
        "If the account already exists outside this organization, remove it or point the eval at a different account.",
    );
    context = await fetchOrgContext(ctx, ownerToken);
    member = findMemberByAccount(context, actor.account);
  }

  ctx.assert(Boolean(member), `${actor.account} did not appear in the organization.`);
  if (!member) throw new Error(`${actor.account} is missing from the organization.`);

  if (!member.isOwner && member.role !== actor.role) {
    const updated = await updateMemberRoleApi(ownerToken, member.id, actor.role);
    ctx.assert(updated.response.ok, `Could not reset ${actor.account} to ${actor.role}: ${updated.response.status}.`);
    member = { ...member, role: actor.role };
  }
  return member;
}

async function ensureFixturePrepared(ctx: FlowContext): Promise<void> {
  if (state.prepared) return;

  ctx.assert(Boolean(SERVER_URL), "JUGGLEWORK_EVAL_SERVER_URL must point at the jugglework-server origin.");
  ctx.assert(Boolean(OWNER_PASSWORD), "JUGGLEWORK_EVAL_ORG_ROLES_OWNER_PASSWORD must be the bootstrap owner password.");

  // Every jugglework-server deployment is multi-organization; a server old
  // enough to still report single_org cannot prove the creation gate.
  const runtime = await apiFetch("/runtime-config");
  ctx.assert(runtime.response.ok, `runtime-config failed: ${runtime.response.status}.`);
  const orgMode = isRecord(runtime.body) ? stringField(runtime.body, "orgMode") : null;
  ctx.assert(
    orgMode !== "single_org",
    "This server still reports single_org; upgrade it before running the owner-only creation frame.",
  );

  const ownerToken = await tokenForActor(ctx, OWNER_ACCOUNT, OWNER_PASSWORD);
  const context = await fetchOrgContext(ctx, ownerToken);
  ctx.assert(context.currentMember.isOwner, `${OWNER_ACCOUNT} is not the owner of the active organization.`);
  state.orgId = context.organization.id;
  state.orgSlug = context.organization.slug;
  state.orgName = context.organization.name;

  const admin = await ensureActor(ctx, ownerToken, ADMIN);
  const member = await ensureActor(ctx, ownerToken, MEMBER);
  state.adminMemberId = admin.id;
  state.memberMemberId = member.id;

  ctx.output("cloud-org-roles-fixture", JSON.stringify({
    organization: context.organization,
    owner: OWNER_ACCOUNT,
    admin: { account: admin.account, role: admin.role, id: admin.id },
    member: { account: member.account, role: member.role, id: member.id },
  }, null, 2));
  state.prepared = true;
}

async function navigateToAbsolute(ctx: FlowContext, url: string): Promise<void> {
  await ctx.eval(`(() => { location.assign(${JSON.stringify(url)}); return true; })()`);
}

// The console is exported statically with trailingSlash, so every route needs
// its trailing slash to avoid a redirect round trip.
async function goToConsole(ctx: FlowContext, pathname: string): Promise<void> {
  const normalized = pathname.endsWith("/") ? pathname : `${pathname}/`;
  await navigateToAbsolute(ctx, `${CONSOLE_BASE}${normalized}`);
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label: `load ${pathname}` });
}

async function clearConsoleSession(ctx: FlowContext): Promise<void> {
  await goToConsole(ctx, "/");
  await ctx.eval(
    `fetch('/jwork/api/auth/sign-out', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => null).then(() => {
      localStorage.clear();
      sessionStorage.clear();
      return true;
    })`,
    { awaitPromise: true },
  );
  if (ctx.client) await ctx.client.send("Network.clearBrowserCookies", {});
}

async function signInToConsole(ctx: FlowContext, account: string, password: string): Promise<void> {
  await clearConsoleSession(ctx);
  await goToConsole(ctx, "/");
  const signedIn = await ctx.eval(
    `fetch('/jwork/api/auth/sign-in/account', {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: ${JSON.stringify(account)}, password: ${JSON.stringify(password)} }),
    }).then(async (response) => ({ ok: response.ok, status: response.status, text: (await response.text()).slice(0, 300) }))`,
    { awaitPromise: true },
  );
  ctx.assert(isRecord(signedIn) && signedIn.ok === true, `Could not sign in ${account} in the console: ${JSON.stringify(signedIn)}`);
  await waitForConsoleSession(ctx, account);
  await setConsoleActiveOrganization(ctx);
  await goToConsole(ctx, "/dashboard");
  await waitForDashboardNav(ctx);
}

async function waitForConsoleSession(ctx: FlowContext, account: string): Promise<void> {
  const normalized = account.toLowerCase();
  await ctx.waitFor(
    `fetch('/jwork/api/v1/me', { credentials: 'include', cache: 'no-store', headers: { accept: 'application/json' } })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => (payload?.user?.account ?? '').toLowerCase() === ${JSON.stringify(normalized)})
      .catch(() => false)`,
    { timeoutMs: 45_000, label: `console session for ${account}` },
  );
}

async function setConsoleActiveOrganization(ctx: FlowContext): Promise<void> {
  const orgId = requireStateString(state.orgId, "organization id");
  await ctx.waitFor(
    `fetch('/jwork/api/v1/me/active-organization', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId: ${JSON.stringify(orgId)} }),
    }).then((response) => response.ok).catch(() => false)`,
    { timeoutMs: 30_000, label: "switch console active organization" },
  );
}

async function waitForDashboardNav(ctx: FlowContext): Promise<void> {
  await ctx.waitFor("Boolean(document.querySelector('nav')?.innerText.includes('Dashboard'))", { timeoutMs: 30_000, label: "dashboard nav" });
}

async function getNavText(ctx: FlowContext): Promise<string> {
  const value = await ctx.eval("document.querySelector('nav')?.innerText ?? ''");
  return typeof value === "string" ? value : "";
}

async function visibleSidebarChildren(ctx: FlowContext): Promise<string[]> {
  const value = await ctx.eval(`(() => {
    const groups = [...document.querySelectorAll('nav .border-l')];
    const active = groups[0];
    return active ? [...active.querySelectorAll('a')].map((element) => (element.textContent ?? '').replace(/\\s+/g, ' ').trim().replace(/\\s*Beta$/, '')) : [];
  })()`);
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

function assertStringListIncludes(ctx: FlowContext, actual: string[], expected: string[], label: string): void {
  for (const item of expected) {
    ctx.assert(actual.includes(item), `${label} missing ${item}; saw ${JSON.stringify(actual)}.`);
  }
}

async function openMembersTab(ctx: FlowContext): Promise<void> {
  await goToConsole(ctx, "/dashboard/members");
  await ctx.waitFor("document.body.innerText.includes('Create member accounts, assign roles, and keep access clean.')", { timeoutMs: 30_000, label: "members screen" });
}

async function openRolesTab(ctx: FlowContext): Promise<void> {
  await ctx.waitFor(`(() => {
    const button = [...document.querySelectorAll('button')].find((candidate) => (candidate.textContent ?? '').trim().startsWith('Roles'));
    button?.click();
    return Boolean(button);
  })()`, { timeoutMs: 20_000, label: "open roles tab" });
  await ctx.waitFor("document.body.innerText.includes('Default roles') || document.body.innerText.includes('Role definitions')", { timeoutMs: 20_000, label: "roles tab" });
}

// Account-only members are displayed by their account name.
async function openMemberActions(ctx: FlowContext, account: string): Promise<void> {
  await ctx.waitFor(`(() => {
    const button = document.querySelector(${JSON.stringify(`button[aria-label="Open actions for ${account}"]`)});
    button?.scrollIntoView({ block: 'center' });
    button?.click();
    return Boolean(button);
  })()`, { timeoutMs: 20_000, label: `open member actions for ${account}` });
  await ctx.waitFor("document.body.innerText.includes('Edit role') || document.body.innerText.includes('Remove member')", { timeoutMs: 10_000, label: "member action menu" });
}

type GeneralSettingsControlState = {
  nameInputDisabled: boolean;
  saveButtonDisabled: boolean;
};

async function readGeneralSettingsControlState(ctx: FlowContext): Promise<GeneralSettingsControlState> {
  const value = await ctx.eval(`(() => {
    const nameInput = [...document.querySelectorAll('input')].find((input) => input.closest('label')?.textContent?.includes('Name'));
    const save = [...document.querySelectorAll('button')].find((button) => (button.textContent ?? '').trim() === 'Save settings');
    return { nameInputDisabled: Boolean(nameInput?.disabled), saveButtonDisabled: Boolean(save?.disabled) };
  })()`);
  return {
    nameInputDisabled: isRecord(value) && value.nameInputDisabled === true,
    saveButtonDisabled: isRecord(value) && value.saveButtonDisabled === true,
  };
}
