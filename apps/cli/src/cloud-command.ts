import { spawn } from "node:child_process";
import { stdin, stdout } from "node:process";
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { filterImportableCloudOrgProviders, getCloudManagedProviderId } from "@jugglework/cloud-provider";
import type { CliOptions } from "./args.js";
import { CloudClient, CloudHttpError, type CloudOrganization } from "./cloud-client.js";
import { CloudProfileStore, cloudProfilePath } from "./cloud-profiles.js";
import { normalizeCloudUrl } from "./cloud-url.js";
import type { CliRenderer } from "./render.js";

export function isCloudOnlyCommand(command: CliOptions["command"]): boolean {
  return command.group === "account" || command.group === "org" || command.group === "catalog" || command.group === "model" || (command.group === "provider" && command.action === "list");
}

export function parseLoginGrant(value: string): string | null {
  const input = value.trim();
  if (!input) return null;
  try {
    const url = new URL(input);
    if (url.protocol !== "jugglework-cli:" || url.hostname.toLowerCase() !== "den-auth") return null;
    return validGrant(url.searchParams.get("grant") ?? "");
  } catch {
    return validGrant(input);
  }
}

function validGrant(value: string): string | null {
  const grant = value.trim();
  return /^[A-Za-z0-9_-]{12,256}$/.test(grant) ? grant : null;
}

export function buildLoginUrl(origin: string): string {
  const url = new URL(`${origin}/jwork/login`);
  url.searchParams.set("mode", "sign-in");
  url.searchParams.set("desktopAuth", "1");
  url.searchParams.set("desktopScheme", "jugglework-cli");
  return url.toString();
}

function tryOpenBrowser(url: string): void {
  const [command, args] = process.platform === "darwin"
    ? ["open", [url]]
    : process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function promptHidden(): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") return readAllStdin();
  emitKeypressEvents(stdin);
  const previousRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      stdin.off("keypress", onKeypress);
      stdin.setRawMode(previousRaw);
      stdin.pause();
      stdout.write("\n");
      if (error) reject(error);
      else resolve(value.trim());
    };
    const onKeypress = (text: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === "c" || key.name === "escape") return finish(new Error("Cloud login was cancelled."));
      if (key.name === "return" || key.name === "enter") return finish();
      if (key.name === "backspace") {
        value = Array.from(value).slice(0, -1).join("");
        return;
      }
      if (!text || /[\u0000-\u001f\u007f]/.test(text)) return;
      if (value.length + text.length > 4096) return finish(new Error("Cloud login handoff input is too long."));
      value += text;
    };
    stdin.on("keypress", onKeypress);
    stdout.write("Paste the one-time grant or jugglework-cli://den-auth link: ");
  });
}

async function chooseOrganization(organizations: CloudOrganization[]): Promise<CloudOrganization> {
  stdout.write(`${organizations.map((organization, index) => `${index + 1}. ${organization.name} (${organization.slug})`).join("\n")}\n`);
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  try {
    const answer = Number((await rl.question("Choose an organization: ")).trim());
    const selected = organizations[answer - 1];
    if (!selected) throw new Error("No organization was selected.");
    return selected;
  } finally {
    rl.close();
  }
}

function catalogItems(payload: unknown): Array<{ id: string; name: string; provider?: string }> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const root = payload as Record<string, unknown>;
  const providerRoot = root.providers && typeof root.providers === "object" && !Array.isArray(root.providers)
    ? root.providers as Record<string, unknown>
    : root;
  const providers = Object.entries(providerRoot);
  return providers.flatMap(([providerId, providerValue]) => {
    if (!providerValue || typeof providerValue !== "object" || Array.isArray(providerValue)) return [];
    const provider = providerValue as Record<string, unknown>;
    const models = provider.models && typeof provider.models === "object" && !Array.isArray(provider.models)
      ? Object.entries(provider.models as Record<string, unknown>)
      : [];
    return models.map(([id, modelValue]) => {
      const model = modelValue && typeof modelValue === "object" && !Array.isArray(modelValue) ? modelValue as Record<string, unknown> : {};
      return { id, name: typeof model.name === "string" ? model.name : id, provider: providerId };
    });
  });
}

export async function executeCloudCommand(options: CliOptions, renderer: CliRenderer, loginMode: "browser" | "paste" = "browser"): Promise<number> {
  const urls = normalizeCloudUrl(options.cloudUrl);
  const client = new CloudClient(urls);
  const store = new CloudProfileStore(cloudProfilePath(options.configPath));
  const persisted = await store.get(urls.origin);
  const token = options.cloudToken ?? persisted?.token ?? null;
  renderer.registerSecretValues([token]);

  if (options.command.group === "catalog") {
    renderer.inventory("Public catalog metadata", "catalog", catalogItems(await client.catalog()));
    return 0;
  }

  if (options.command.group === "account" && options.command.action === "login") {
    const loginUrl = buildLoginUrl(urls.origin);
    renderer.info(loginMode === "browser"
      ? "Open this URL in a browser, sign in, then paste the resulting one-time grant or handoff link:"
      : "Open this URL on another device, sign in, then paste the resulting one-time grant or handoff link:");
    renderer.info(loginUrl);
    if (stdin.isTTY && loginMode === "browser") tryOpenBrowser(loginUrl);
    const raw = options.grantStdin || !stdin.isTTY ? await readAllStdin() : await promptHidden();
    const grant = parseLoginGrant(raw);
    if (!grant) throw new Error("The pasted Cloud login grant or handoff link is malformed.");
    renderer.registerSecretValues([grant]);
    const exchange = await client.exchangeHandoff(grant);
    renderer.registerSecretValues([exchange.token]);
    const user = await client.currentUser(exchange.token);
    await store.set(urls.origin, { token: exchange.token, user });
    renderer.account("signed_in", user, urls.origin);
    return 0;
  }

  if (options.command.group === "account" && options.command.action === "login-status") {
    if (!token) {
      renderer.account("signed_out", null, urls.origin);
      return 1;
    }
    try {
      renderer.account("signed_in", await client.currentUser(token), urls.origin);
      return 0;
    } catch (error) {
      if (error instanceof CloudHttpError && (error.status === 401 || error.status === 403)) {
        renderer.account("signed_out", null, urls.origin);
        return 1;
      }
      throw error;
    }
  }

  if (options.command.group === "account" && options.command.action === "logout") {
    if (token) {
      try { await client.logout(token); } catch (error) {
        if (!(error instanceof CloudHttpError && (error.status === 401 || error.status === 403 || error.status === 404))) throw error;
      }
    }
    await store.remove(urls.origin);
    renderer.account("signed_out", null, urls.origin);
    return 0;
  }

  if (!token) throw new Error("Not signed in to JuggleWork Cloud. Run 'jugglework login'.");
  const organizations = await client.organizations(token);
  let selectedId = options.cloudOrg ?? persisted?.organizationId ?? null;
  if (selectedId && !organizations.some((organization) => organization.id === selectedId || organization.slug === selectedId)) {
    if (!options.cloudToken && persisted?.organizationId) await store.selectOrganization(urls.origin, null);
    selectedId = null;
  }

  if (options.command.group === "org" && options.command.action === "list") {
    renderer.organizations(organizations, selectedId);
    return 0;
  }

  if (options.command.group === "org" && options.command.action === "use") {
    const target = options.command.target;
    let matches = target ? organizations.filter((organization) => organization.id === target || organization.slug === target) : organizations;
    let selected: CloudOrganization;
    if (matches.length === 1) selected = matches[0]!;
    else if (stdin.isTTY && stdout.isTTY && !options.json && matches.length > 0) selected = await chooseOrganization(matches);
    else if (!target) throw new Error("org use requires an organization ID or slug in non-interactive mode.");
    else if (matches.length === 0) throw new Error(`No organization exactly matches '${target}'.`);
    else throw new Error(`Organization '${target}' is ambiguous.`);
    if (!options.cloudToken) await store.selectOrganization(urls.origin, selected.id);
    renderer.organizationSelected(selected, options.cloudToken !== null);
    return 0;
  }

  const organization = organizations.find((item) => item.id === selectedId || item.slug === selectedId);
  if (!organization) throw new Error("No organization is selected. Run 'jugglework org use <id-or-slug>'.");
  const providers = filterImportableCloudOrgProviders(await client.providers(token, organization.id));
  if (options.command.group === "provider") {
    renderer.inventory("Organization providers", "providers", providers.map((provider) => ({
      id: getCloudManagedProviderId(provider), name: provider.name, providerId: provider.providerId,
      published: true, imported: null, loaded: null, authenticated: null,
      enabled: provider.enabled ?? null, verifiedExecutable: null,
    })), organization);
    return 0;
  }
  if (options.command.group === "model") {
    renderer.inventory("Organization models", "models", providers.flatMap((provider) => provider.models.map((model) => ({
      id: model.id, name: model.name, providerId: provider.providerId, providerName: provider.name,
      published: true, imported: null, loaded: null, authenticated: null,
      enabled: provider.enabled ?? null, verifiedExecutable: null,
    }))), organization);
    return 0;
  }
  throw new Error("Unsupported Cloud command.");
}
