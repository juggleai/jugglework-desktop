import { lookup } from "node:dns/promises";
import type { IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

export type ProtectedMediaTarget = { url: URL; address: string };
export type ProtectedMediaResolver = (hostname: string) => Promise<readonly { address: string; family?: number }[]>;
export type ProtectedMediaRequest = (target: ProtectedMediaTarget, signal: AbortSignal) => Promise<Response>;

export type ProtectedMediaFetchOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRedirects?: number;
  resolver?: ProtectedMediaResolver;
  fetch?: ProtectedMediaRequest;
};

function ipv4Value(address: string): number | null {
  if (isIP(address) !== 4) return null;
  return address.split(".").reduce((value, octet) => value * 256 + Number(octet), 0) >>> 0;
}

function ipv6Value(address: string): bigint | null {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0]!;
  if (isIP(normalized) !== 6) return null;
  const sides = normalized.split("::");
  if (sides.length > 2) return null;
  const left = sides[0] ? sides[0].split(":") : [];
  const right = sides[1] ? sides[1].split(":") : [];
  const groups = sides.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
  if (groups.length !== 8) return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt(Number.parseInt(group || "0", 16)), 0n);
}

function ipv4InCidr(address: number, base: string, prefix: number): boolean {
  const baseValue = ipv4Value(base)!;
  const shift = 32 - prefix;
  return shift === 32 || (address >>> shift) === (baseValue >>> shift);
}

function ipv6InCidr(address: bigint, base: string, prefix: number): boolean {
  const baseValue = ipv6Value(base)!;
  return (address >> BigInt(128 - prefix)) === (baseValue >> BigInt(128 - prefix));
}

const blockedIpv4Cidrs: readonly [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.31.196.0", 24], ["192.52.193.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["192.175.48.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
];

export function isPublicMediaAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0]!;
  const ipv4 = ipv4Value(normalized);
  if (ipv4 !== null) return !blockedIpv4Cidrs.some(([base, prefix]) => ipv4InCidr(ipv4, base, prefix));
  const ipv6 = ipv6Value(normalized);
  if (ipv6 === null) return false;
  if (ipv6InCidr(ipv6, "::ffff:0:0", 96)) return false;
  if (!ipv6InCidr(ipv6, "2000::", 3)) return false;
  return !ipv6InCidr(ipv6, "2001::", 23)
    && !ipv6InCidr(ipv6, "2001:db8::", 32)
    && !ipv6InCidr(ipv6, "2002::", 16)
    && !ipv6InCidr(ipv6, "3ffe::", 16)
    && !ipv6InCidr(ipv6, "3fff::", 20);
}

const defaultResolver: ProtectedMediaResolver = async (hostname) => lookup(hostname, { all: true, verbatim: true });

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const finish = () => signal.removeEventListener("abort", abort);
    const abort = () => { finish(); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => { finish(); resolve(value); },
      (error) => { finish(); reject(error); },
    );
  });
}

async function protectedTarget(value: string, resolver: ProtectedMediaResolver, signal: AbortSignal): Promise<ProtectedMediaTarget> {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("external_media_invalid_url"); }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("external_media_insecure_url");
  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (["metadata", "metadata.google.internal", "metadata.goog", "instance-data", "instance-data.ec2.internal"].includes(hostname.toLowerCase())) {
    throw new Error("external_media_unsafe_url");
  }
  const addresses = isIP(hostname) ? [{ address: hostname }] : await abortable(resolver(hostname), signal).catch(() => []);
  if (!addresses.length || addresses.some(({ address }) => !isPublicMediaAddress(address))) throw new Error("external_media_unsafe_url");
  return { url, address: addresses[0]!.address };
}

function responseFromIncoming(message: IncomingMessage): Response {
  const headers = new Headers();
  for (let index = 0; index < message.rawHeaders.length; index += 2) headers.append(message.rawHeaders[index]!, message.rawHeaders[index + 1]!);
  const status = message.statusCode ?? 502;
  const body = status === 204 || status === 205 || status === 304 ? null : Readable.toWeb(message) as unknown as ReadableStream<Uint8Array>;
  return new Response(body, { status, statusText: message.statusMessage, headers });
}

const requestPinnedMedia: ProtectedMediaRequest = (target, signal) => new Promise((resolve, reject) => {
  const hostname = target.url.hostname.replace(/^\[|\]$/g, "");
  const request = httpsRequest({
    protocol: "https:", hostname: target.address, family: isIP(target.address), port: target.url.port || 443,
    path: `${target.url.pathname}${target.url.search}`, method: "GET", servername: hostname,
    headers: { Host: target.url.host }, signal,
  }, (message) => resolve(responseFromIncoming(message)));
  request.on("error", reject);
  request.end();
});

export async function protectedMediaFetch(value: string, options: ProtectedMediaFetchOptions = {}): Promise<Response> {
  const resolver = options.resolver ?? defaultResolver;
  const fetch = options.fetch ?? requestPinnedMedia;
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 120_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  const maxRedirects = options.maxRedirects ?? 5;
  let target = await protectedTarget(value, resolver, signal);
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const response = await fetch(target, signal);
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (!location || redirects === maxRedirects) throw new Error("external_media_redirect_invalid");
    target = await protectedTarget(new URL(location, target.url).toString(), resolver, signal);
  }
  throw new Error("external_media_redirect_invalid");
}
