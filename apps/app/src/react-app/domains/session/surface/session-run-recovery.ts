import { JuggleWorkServerError } from "@/app/lib/jugglework-server";

export function isSessionBusyError(error: unknown): error is JuggleWorkServerError {
  return error instanceof JuggleWorkServerError && error.status === 409 && error.code === "session_busy";
}

export function effectiveSessionRunning(input: {
  sending: boolean;
  liveStatus: string;
  activityRunActive: boolean;
  coordinatorActive: boolean;
}): boolean {
  return input.sending || input.activityRunActive || input.coordinatorActive ||
    input.liveStatus === "busy" || input.liveStatus === "retry";
}
