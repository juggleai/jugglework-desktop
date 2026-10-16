/** @jsxImportSource react */
import * as React from "react";
import type { DesktopRemoteControlPolicyScope } from "@jugglework/types/desktop-ipc";

import {
  createDenClient,
  DEFAULT_DEN_BASE_URL,
  DenClient,
  readDenSettings,
  type DenOrgSummary,
  type DenUser,
} from "../../../../app/lib/den";
import { denSettingsChangedEvent } from "../../../../app/lib/den-session-events";

type CloudActiveOrganization = Pick<DenOrgSummary, "id" | "name" | "role" | "slug" | "kind">;

type CloudSessionContextValue = {
  client: DenClient;
  baseUrl: string;
  setBaseUrl: React.Dispatch<React.SetStateAction<string>>;
  authToken: string;
  setAuthToken: React.Dispatch<React.SetStateAction<string>>;
  isSignedIn: boolean;
  setIsSignedIn: React.Dispatch<React.SetStateAction<boolean>>;
  user: DenUser | null;
  setUser: React.Dispatch<React.SetStateAction<DenUser | null>>;
  statusMessage: string | null;
  setStatusMessage: React.Dispatch<React.SetStateAction<string | null>>;
  activeOrganization: CloudActiveOrganization | null;
  setActiveOrganization: React.Dispatch<React.SetStateAction<CloudActiveOrganization | null>>;
  activeOrgName: string;
  hasActiveOrg: boolean;
  getCurrentScope: () => DesktopRemoteControlPolicyScope | null;
};

const CloudSessionContext = React.createContext<CloudSessionContextValue | null>(null);

type CloudSessionProviderProps = {
  children: React.ReactNode;
};

export function CloudSessionProvider({ children }: CloudSessionProviderProps) {
  const initial = React.useMemo(() => readDenSettings(), []);

  const [baseUrl, setBaseUrl] = React.useState(() => initial.baseUrl || DEFAULT_DEN_BASE_URL);
  const [authToken, setAuthToken] = React.useState(initial.authToken?.trim() || "");
  const [isSignedIn, setIsSignedIn] = React.useState(false);
  const [user, setUser] = React.useState<DenUser | null>(null);
  const [statusMessage, setStatusMessage] = React.useState<string | null>(null);
  const [activeOrganization, setActiveOrganization] =
    React.useState<CloudActiveOrganization | null>(() => {
      const id = initial.activeOrgId?.trim();
      if (!id) return null;

      return {
        id,
        name: initial.activeOrgName?.trim() || "",
        role: "member",
        slug: initial.activeOrgSlug?.trim() || "",
      };
    });
  const activeOrgName = activeOrganization?.name ?? "";
  const hasActiveOrg = Boolean(activeOrganization);
  const currentScopeRef = React.useRef<DesktopRemoteControlPolicyScope | null>(null);
  currentScopeRef.current = isSignedIn && user?.id?.trim() && activeOrganization?.id?.trim() && baseUrl.trim()
    ? { controlPlaneBaseUrl: baseUrl.trim(), userId: user.id.trim(), organizationId: activeOrganization.id.trim() }
    : null;
  const getCurrentScope = React.useCallback(() => currentScopeRef.current, []);

  React.useEffect(() => {
    if (typeof window === "undefined") return;

    let previous = initial;
    const handleSettingsChanged = () => {
      const next = readDenSettings();
      const identityChanged = next.baseUrl !== previous.baseUrl || next.authToken !== previous.authToken;
      previous = next;
      setBaseUrl(next.baseUrl || DEFAULT_DEN_BASE_URL);
      setAuthToken(next.authToken?.trim() || "");
      if (identityChanged) {
        setUser(null);
        setIsSignedIn(false);
      }
      setActiveOrganization((current) => {
        const id = next.activeOrgId?.trim();
        if (!id) return null;
        const name = next.activeOrgName?.trim() || "";
        const slug = next.activeOrgSlug?.trim() || "";
        if (!identityChanged && current?.id === id && current.name === name && current.slug === slug) return current;
        return {
          id,
          name,
          slug,
          role: !identityChanged && current?.id === id ? current.role : "member",
          kind: !identityChanged && current?.id === id ? current.kind : undefined,
        };
      });
    };

    window.addEventListener(denSettingsChangedEvent, handleSettingsChanged);
    handleSettingsChanged();
    return () => window.removeEventListener(denSettingsChangedEvent, handleSettingsChanged);
  }, [initial]);

  const client = React.useMemo(
    () => createDenClient({ baseUrl, token: authToken }),
    [authToken, baseUrl],
  );

  const value = React.useMemo<CloudSessionContextValue>(
    () => ({
      client,
      baseUrl,
      setBaseUrl,
      authToken,
      setAuthToken,
      isSignedIn,
      setIsSignedIn,
      user,
      setUser,
      statusMessage,
      setStatusMessage,
      activeOrganization,
      setActiveOrganization,
      activeOrgName,
      hasActiveOrg,
      getCurrentScope,
    }),
    [activeOrgName, activeOrganization, authToken, baseUrl, client, getCurrentScope, hasActiveOrg, isSignedIn, statusMessage, user],
  );

  return <CloudSessionContext.Provider value={value}>{children}</CloudSessionContext.Provider>;
}

export function useCloudSession() {
  const context = React.use(CloudSessionContext);

  if (!context) {
    throw new Error("useCloudSession must be used within a CloudSessionProvider");
  }

  return context;
}
