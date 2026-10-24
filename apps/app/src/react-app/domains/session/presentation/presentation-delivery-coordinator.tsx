import * as React from "react";
import type { OpenTargetOptions } from "@/lib/target-provider";
import type { OpenTarget } from "../artifacts/open-target";
import { useFileDeliveries } from "../artifacts/file-deliveries-provider";
import {
  consumePresentationDelivery,
  presentationDeliveryTerminal,
  resolvePresentationDelivery,
} from "./presentation-delivery";
import { getPendingPresentationTurnIds, usePresentationPendingStore } from "./presentation-pending-store";

export function PresentationDeliveryCoordinator({
  workspaceId,
  sessionId,
  onOpenTarget,
}: {
  workspaceId: string;
  sessionId: string;
  onOpenTarget?: (target: OpenTarget, options?: OpenTargetOptions, sessionId?: string) => void;
}) {
  const deliveries = useFileDeliveries();
  const turnIds = usePresentationPendingStore((state) => getPendingPresentationTurnIds(state, workspaceId, sessionId));
  const remove = usePresentationPendingStore((state) => state.remove);

  React.useEffect(() => {
    for (const turnId of turnIds) {
      const match = resolvePresentationDelivery(deliveries?.data, sessionId, turnId);
      if (match) {
        if (!onOpenTarget) continue;
        if (consumePresentationDelivery(workspaceId, sessionId, turnId, match.artifactId)) {
          onOpenTarget(match.target, { auto: true, intent: "presentation-creation" }, sessionId);
        }
        remove(workspaceId, sessionId, turnId);
        continue;
      }
      if (presentationDeliveryTerminal(deliveries?.data, sessionId, turnId)) {
        remove(workspaceId, sessionId, turnId);
      }
    }
  }, [deliveries?.data, onOpenTarget, remove, sessionId, turnIds, workspaceId]);

  return null;
}
