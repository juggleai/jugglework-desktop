import {
  JuggleWorkServerError,
  type JuggleWorkServerClient,
} from "../../../../app/lib/jugglework-server";
import { gatewayMirrorEnvName } from "./cloud-provider-config";

type GatewayMirrorClient = Pick<
  JuggleWorkServerClient,
  "upsertUserEnv" | "deleteUserEnv"
>;

type GatewayMirrorOperation = "write" | "delete";

const MISSING_USER_ENV_CAPABILITY_ERRORS = new Set([
  "404:not_found",
  "404:route_not_found",
  "405:method_not_allowed",
  "501:not_implemented",
  "501:unimplemented",
]);

export function isBenignGatewayMirrorError(
  error: unknown,
  operation: GatewayMirrorOperation,
): boolean {
  if (!(error instanceof JuggleWorkServerError)) return false;
  if (operation === "delete" && error.status === 404) return true;
  return MISSING_USER_ENV_CAPABILITY_ERRORS.has(
    `${error.status}:${error.code.trim().toLowerCase()}`,
  );
}

function mirrorFailure(operation: GatewayMirrorOperation): Error {
  return new Error(
    operation === "write"
      ? "Could not store the cloud provider gateway credential. Retry the import."
      : "Could not remove the cloud provider gateway credential. Retry the removal.",
  );
}

export async function writeGatewayMirror(
  client: GatewayMirrorClient | null | undefined,
  cloudProviderId: string,
  token: string,
): Promise<void> {
  if (!client) return;
  try {
    await client.upsertUserEnv([
      { key: gatewayMirrorEnvName(cloudProviderId), value: token },
    ]);
  } catch (error) {
    if (isBenignGatewayMirrorError(error, "write")) return;
    throw mirrorFailure("write");
  }
}

export async function removeGatewayMirror(
  client: GatewayMirrorClient | null | undefined,
  cloudProviderId: string,
): Promise<void> {
  if (!client) return;
  try {
    await client.deleteUserEnv(gatewayMirrorEnvName(cloudProviderId));
  } catch (error) {
    if (isBenignGatewayMirrorError(error, "delete")) return;
    throw mirrorFailure("delete");
  }
}
