import * as React from "react";
import type { OpenTargetOptions } from "@/lib/target-provider";
import type { OpenTarget } from "../artifacts/open-target";
import { useFileDeliveries } from "../artifacts/file-deliveries-provider";
import {
  consumePresentationDelivery,
  presentationDeliveryTerminal,
  resolvePresentationDelivery,
} from "./presentation-delivery";

export function PresentationDeliveryCoordinator({
  sessionId,
  turnId,
  onOpenTarget,
  onFinished,
}: {
  sessionId: string;
  turnId: string | null;
  onOpenTarget?: (target: OpenTarget, options?: OpenTargetOptions, sessionId?: string) => void;
  onFinished: (turnId: string) => void;
}) {
  const deliveries = useFileDeliveries();

  React.useEffect(() => {
    if (!turnId) return;
    const match = resolvePresentationDelivery(deliveries?.data, sessionId, turnId);
    if (match) {
      if (!onOpenTarget) return;
      if (consumePresentationDelivery(sessionId, turnId, match.artifactId)) {
        onOpenTarget(match.target, { auto: true, intent: "presentation-creation" }, sessionId);
      }
      onFinished(turnId);
      return;
    }
    if (presentationDeliveryTerminal(deliveries?.data, sessionId, turnId)) onFinished(turnId);
  }, [deliveries?.data, onFinished, onOpenTarget, sessionId, turnId]);

  return null;
}
