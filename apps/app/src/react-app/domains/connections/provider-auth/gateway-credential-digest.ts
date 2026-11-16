const bytesToHex = (bytes: Uint8Array) =>
  [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");

/** Hashes an opaque gateway credential before it crosses the control-plane API. */
export async function digestGatewayCredential(credential: string): Promise<string> {
  const normalized = credential.trim();
  if (!normalized.startsWith("jwgw_")) {
    throw new Error("The rejected credential is not a JuggleWork gateway credential.");
  }
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalized),
  );
  return bytesToHex(new Uint8Array(digest));
}
