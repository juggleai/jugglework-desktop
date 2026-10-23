/** @jsxImportSource react */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { buildDenDashboardUrl, type DenExternalMcpConnection } from "@/app/lib/den";
import { currentLocale } from "@/i18n";
import { usePlatform } from "@/react-app/kernel/platform";
import { useCloudSession } from "../settings/cloud/cloud-session-provider";
import { useOrgMcpConnections, resolveOrgMcpConnectionCardState } from "../connections/use-org-mcp-connections";
import { ConnectorAuthorizationContent } from "../connections/connector-authorization-dialog";

const text = (en: string, zh: string) => currentLocale() === "zh" ? zh : en;

export function isReviewGitHubConnection(connection: Pick<DenExternalMcpConnection, "url"> & Partial<Pick<DenExternalMcpConnection, "name">>): boolean {
  // Member-safe lists deliberately omit the endpoint. Prefer the review's
  // connection ID below; the standard name supports missing-capability setup.
  if (!connection.url) return connection.name?.trim().toLowerCase() === "github";
  try {
    const url = new URL(connection.url);
    return url.hostname === "api.githubcopilot.com" && url.pathname.replace(/\/+$/, "") === "/mcp";
  } catch {
    return false;
  }
}

export function reviewGitHubSetupUrl(baseUrl: string, organizationId: string): string {
  const url = new URL(`${buildDenDashboardUrl(baseUrl).replace(/\/+$/, "")}/dashboard/mcp-connections/`);
  url.searchParams.set("organizationId", organizationId);
  url.searchParams.set("quickAdd", "github");
  url.searchParams.set("flow", "code-review");
  return url.toString();
}

type ConnectionDialog = "consent" | "owner-required" | "setup" | null;

/** Resolve against the current organization before opening any authorization. */
export function ReviewGitHubConnection(props: {
  connectionId?: string;
  onConnected: () => void;
  children: (open: () => void) => ReactNode;
}) {
  const cloud = useCloudSession();
  const platform = usePlatform();
  const org = useOrgMcpConnections();
  const [dialog, setDialog] = useState<ConnectionDialog>(null);
  const [selected, setSelected] = useState<DenExternalMcpConnection | null>(null);
  const [busy, setBusy] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scope = `${cloud.baseUrl}:${cloud.authToken}:${cloud.activeOrganization?.id ?? ""}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const dialogScopeRef = useRef(scope);
  const onConnectedRef = useRef(props.onConnected);
  onConnectedRef.current = props.onConnected;

  useEffect(() => {
    setDialog(null);
    setSelected(null);
    setBusy(false);
    setAuthorizing(false);
    setError(null);
  }, [scope]);

  useEffect(() => {
    if (dialogScopeRef.current !== scope) return;
    const candidate = dialog === "setup"
      ? org.connections.find(isReviewGitHubConnection)
      : org.connections.find((entry) => entry.id === selected?.id);
    if (!candidate) return;
    if ((authorizing || dialog === "setup") && resolveOrgMcpConnectionCardState(candidate).connected) {
      setDialog(null);
      setAuthorizing(false);
      onConnectedRef.current();
    } else if (dialog === "setup") {
      setSelected(candidate);
      setDialog("consent");
    }
  }, [org.connections, selected?.id, authorizing, dialog, scope]);

  async function open() {
    if (busy) return;
    const requestedScope = scope;
    setBusy(true);
    setError(null);
    try {
      if (!cloud.isSignedIn || !cloud.activeOrganization) {
        throw new Error(text("Sign in and select an organization first.", "请先登录并选择组织。"));
      }
      const findGitHub = (connections: DenExternalMcpConnection[]) => connections.find((entry) => entry.id === props.connectionId)
        ?? connections.find(isReviewGitHubConnection);
      const connections = await cloud.client.listMcpConnections(cloud.activeOrganization.id, "usable");
      if (scopeRef.current !== requestedScope) return;
      dialogScopeRef.current = requestedScope;
      let connection = findGitHub(connections);
      if (!connection && cloud.activeOrganization.role === "owner") {
        // An owner may manage a configured connector without having a usable
        // grant. Do not mistake that for absence and create a duplicate.
        const managed = await cloud.client.listMcpConnections(cloud.activeOrganization.id, "manageable");
        if (scopeRef.current !== requestedScope) return;
        connection = findGitHub(managed);
      }
      if (connection) {
        if (resolveOrgMcpConnectionCardState(connection).connected) {
          onConnectedRef.current();
        } else {
          setSelected(connection);
          setAuthorizing(false);
          setDialog("consent");
        }
      } else if (cloud.activeOrganization.role === "owner") {
        platform.openLink(reviewGitHubSetupUrl(cloud.baseUrl, cloud.activeOrganization.id));
        setDialog("setup");
      } else {
        setDialog("owner-required");
      }
    } catch (failure) {
      if (scopeRef.current === requestedScope) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (scopeRef.current === requestedScope) setBusy(false);
    }
  }

  return <>
    {props.children(() => { void open(); })}
    {busy ? <p role="status" className="absolute bottom-5 left-1/2 -translate-x-1/2 text-sm text-dls-secondary">{text("Checking organization GitHub…", "正在检查组织 GitHub 连接…")}</p> : null}
    {error ? <p role="alert" className="absolute bottom-5 left-1/2 max-w-lg -translate-x-1/2 text-sm text-red-11">{error}</p> : null}
    <Dialog open={dialog !== null} onOpenChange={(open) => { if (!open) setDialog(null); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto p-7 sm:max-w-[520px] sm:p-8">
        {dialog === "consent" ? <ConnectorAuthorizationContent
          name="GitHub"
          approvedByOrganization
          busy={Boolean(org.connectingId)}
          error={org.error}
          onContinue={() => {
            if (!selected || dialogScopeRef.current !== scopeRef.current) return;
            setAuthorizing(true);
            void org.connect(selected.id);
          }}
        /> : <>
          <DialogTitle>{dialog === "setup" ? text("Set up organization GitHub", "配置组织 GitHub") : text("Organization owner required", "需要组织 owner 配置")}</DialogTitle>
          <DialogDescription>{dialog === "setup"
            ? text("The organization connector setup is open in your browser. Configure GitHub there, then complete authorization. Return here to continue Code Review.", "已在浏览器打开组织连接器配置页面。请添加并配置 GitHub，然后完成授权。返回后即可继续代码评审。")
            : text("Ask your organization owner to add and configure a GitHub connector for the organization.", "需要组织 owner 为组织添加并配置 GitHub 连接器，请联系组织 owner。")}</DialogDescription>
          <Button onClick={() => { if (dialog === "setup") void org.refresh(); else setDialog(null); }}>{dialog === "setup" ? text("Check connection", "检查连接") : text("Got it", "知道了")}</Button>
          {org.error ? <p role="alert">{org.error}</p> : null}
        </>}
      </DialogContent>
    </Dialog>
  </>;
}
