/** @jsxImportSource react */
import { useEffect, type ReactNode } from "react";

import { Toaster } from "@/components/ui/sonner";

import { isWebDeployment } from "@/app/lib/jugglework-deployment";
import { hydrateJuggleWorkServerSettingsFromEnv } from "@/app/lib/jugglework-server";
import { isDesktopRuntime } from "@/app/utils";
import { ConnectLinkProvider } from "@/react-app/domains/cloud/connect-link-provider";
import { DenAuthProvider, useDenAuth } from "@/react-app/domains/cloud/den-auth-provider";
import { BrandThemeProvider } from "@/react-app/domains/cloud/brand-theme";
import { DesktopConfigProvider } from "@/react-app/domains/cloud/desktop-config-provider";
import { RestrictionNoticeProvider } from "@/react-app/domains/cloud/restriction-notice-provider";
import { CloudSessionProvider, useCloudSession } from "@/react-app/domains/settings/cloud/cloud-session-provider";
import { LocalProvider } from "@/react-app/kernel/local-provider";
import { ServerProvider } from "@/react-app/kernel/server-provider";
import { ArchitectureMismatchGate } from "./architecture-mismatch-gate";
import { BootStateProvider } from "./boot-state";
import { DesktopRuntimeBoot } from "./desktop-runtime-boot";
import { startDebugLogger, stopDebugLogger } from "./debug-logger";
import { resolveJuggleWorkConnection } from "./jugglework-connection";
import { ReloadCoordinatorProvider } from "./reload-coordinator";

function resolveDefaultServerUrl(): string {
  if (isDesktopRuntime()) return "http://127.0.0.1:4096";

  const juggleworkUrl =
    typeof import.meta.env?.VITE_JUGGLEWORK_URL === "string"
      ? import.meta.env.VITE_JUGGLEWORK_URL.trim()
      : "";
  if (juggleworkUrl) {
    return `${juggleworkUrl.replace(/\/+$/, "")}/opencode`;
  }

  if (isWebDeployment() && import.meta.env.PROD && typeof window !== "undefined") {
    return `${window.location.origin}/opencode`;
  }

  const envUrl =
    typeof import.meta.env?.VITE_OPENCODE_URL === "string"
      ? import.meta.env.VITE_OPENCODE_URL.trim()
      : "";
  return envUrl || "http://127.0.0.1:4096";
}

type AppProvidersProps = {
  children: ReactNode;
};

function CloudSessionAuthBridge() {
  const denAuth = useDenAuth();
  const cloudSession = useCloudSession();

  useEffect(() => {
    cloudSession.setUser(denAuth.user);
    cloudSession.setIsSignedIn(Boolean(denAuth.user) && denAuth.isSignedIn);
    if (denAuth.activeOrganization) {
      cloudSession.setActiveOrganization(denAuth.activeOrganization);
    } else if (denAuth.status === "signed_out") {
      cloudSession.setActiveOrganization(null);
    }
  }, [cloudSession.setActiveOrganization, cloudSession.setIsSignedIn, cloudSession.setUser, denAuth.activeOrganization, denAuth.isSignedIn, denAuth.status, denAuth.user]);

  return null;
}

export function AppProviders({ children }: AppProvidersProps) {
  hydrateJuggleWorkServerSettingsFromEnv();

  useEffect(() => {
    // Start the dev observability forwarder. Reads the current jugglework-server
    // URL on every flush so reconnects after port changes still work. In prod
    // builds `startDebugLogger` is a no-op.
    startDebugLogger({
      serverUrl: async () => (await resolveJuggleWorkConnection()).normalizedBaseUrl,
    });
    return () => {
      stopDebugLogger();
    };
  }, []);

  const defaultUrl = resolveDefaultServerUrl();
  return (
    <BootStateProvider>
      <ServerProvider defaultUrl={defaultUrl}>
        <ArchitectureMismatchGate>
          <DesktopRuntimeBoot />
          <DenAuthProvider>
            <CloudSessionProvider>
            <CloudSessionAuthBridge />
            <ConnectLinkProvider>
              <DesktopConfigProvider>
                <BrandThemeProvider>
                <RestrictionNoticeProvider>
                  <LocalProvider>
                    <ReloadCoordinatorProvider>{children}</ReloadCoordinatorProvider>
                    <Toaster />
                  </LocalProvider>
                </RestrictionNoticeProvider>
                </BrandThemeProvider>
              </DesktopConfigProvider>
            </ConnectLinkProvider>
            </CloudSessionProvider>
          </DenAuthProvider>
        </ArchitectureMismatchGate>
      </ServerProvider>
    </BootStateProvider>
  );
}
