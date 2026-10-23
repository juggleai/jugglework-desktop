/** @jsxImportSource react */
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import type { DenExternalMcpConnection } from "@/app/lib/den";
import { isOrgMcpConnectionReady } from "../../connections/native-provider-connections";
import { ExtensionMeshAvatar } from "@/react-app/design-system/extension-mesh-avatar";
import { resolveExtensionIconUrl } from "@/react-app/design-system/extension-icon-src";

export type OrganizationConnectorActionProps = {
  connection: DenExternalMcpConnection;
  connecting?: boolean;
  disconnecting?: boolean;
  canManageShared: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
};

export function OrganizationConnectorAction(props: OrganizationConnectorActionProps) {
  const ready = isOrgMcpConnectionReady(props.connection);
  const managed = props.connection.credentialMode === "shared" && !props.canManageShared;
  const busy = props.connecting || props.disconnecting;
  return <Button variant="outline" disabled={busy || managed} title={managed ? t("mcp.org_connection_managed_label") : undefined}
    data-testid={`org-connector-action:${props.connection.id}`} onClick={ready ? props.onDisconnect : props.onConnect}>
    {busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
    {props.disconnecting ? t("mcp.org_connection_disconnecting_action") : props.connecting ? t("mcp.waiting_for_browser") : ready ? t("mcp.org_connection_disconnect_action") : t("mcp.connect")}
  </Button>;
}

export function OrganizationConnectorCard(props: OrganizationConnectorActionProps & { onOpenDetail: () => void }) {
  const icon = resolveExtensionIconUrl({ serviceUrl: props.connection.url });
  return <div className="rounded-xl border border-dls-border bg-dls-surface">
    <button type="button" data-testid={`org-connector-open:${props.connection.id}`} onClick={props.onOpenDetail}
      className="flex w-full items-start gap-3 rounded-xl p-4 text-left transition-colors hover:bg-dls-hover">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-dls-border bg-dls-hover">
        {icon ? <img src={icon} alt="" width={24} height={24} /> : <ExtensionMeshAvatar name={props.connection.name} category="mcp" className="size-7 rounded-md" />}
      </span>
      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{props.connection.name}</span>
        <span className="mt-1 block text-xs text-dls-secondary">{t("customization.organization_description")}</span>
        <span className="mt-2 block text-xs text-dls-secondary">{isOrgMcpConnectionReady(props.connection) ? t("mcp.status_connected") : t("project_extensions.unconnected_group")}</span>
      </span>
    </button>
    <div className="flex justify-end px-4 pb-4"><OrganizationConnectorAction {...props} /></div>
  </div>;
}
