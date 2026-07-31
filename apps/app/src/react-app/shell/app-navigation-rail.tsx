/** @jsxImportSource react */
import {
  FilePlus2,
  MessageCircleMore,
  Orbit,
  Settings,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { useBrandLogoUrl } from "@/react-app/domains/cloud/brand-theme";
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider";

export const APP_NAVIGATION_RAIL_WIDTH = 72;

type AppNavigationRailProps = {
  settingsActive?: boolean;
  onCreateLocalWorkspace: () => void;
  onConnectRemoteWorkspace: () => void;
  onOpenSettings: () => void;
};

type RailButtonProps = {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
  testId?: string;
};

function RailButton({
  label,
  active = false,
  disabled = false,
  onClick,
  children,
  testId,
}: RailButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      className={cn(
        "flex size-11 items-center justify-center rounded-2xl border border-transparent text-dls-secondary transition-colors",
        "hover:border-dls-border hover:bg-background hover:text-dls-text",
        active && "border-dls-border bg-background text-dls-text shadow-sm",
        disabled && "cursor-default opacity-45 hover:border-transparent hover:bg-transparent hover:text-dls-secondary",
      )}
    >
      {children}
    </button>
  );
}

export function AppNavigationRail(props: AppNavigationRailProps) {
  const { user } = useDenAuth();
  const brandLogoUrl = useBrandLogoUrl();
  const identity = user?.name?.trim() || user?.email?.trim() || "JuggleWork";
  const initial = identity.slice(0, 1).toLocaleUpperCase();

  return (
    <aside
      aria-label={t("navigation.primary")}
      className="flex h-full w-[72px] shrink-0 flex-col items-center border-r border-dls-border bg-dls-sidebar/75 px-2 pb-3 pt-3 mac:pt-11"
    >
      <div
        className="mb-7 flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-dls-border bg-background text-sm font-semibold text-dls-text shadow-sm"
        title={identity}
        aria-label={identity}
      >
        {brandLogoUrl ? (
          <img src={brandLogoUrl} alt="" className="size-full object-cover" />
        ) : (
          <span aria-hidden="true">{initial}</span>
        )}
      </div>

      <nav className="flex flex-col items-center gap-3">
        <RailButton
          label={t("navigation.local_tasks")}
          onClick={props.onCreateLocalWorkspace}
          testId="app-rail-create-local"
        >
          <FilePlus2 className="size-5" strokeWidth={1.8} />
        </RailButton>
        <RailButton
          label={t("navigation.cloud_tasks")}
          onClick={props.onConnectRemoteWorkspace}
          testId="app-rail-connect-remote"
        >
          <Orbit className="size-5" strokeWidth={1.8} />
        </RailButton>
        <RailButton
          label={t("navigation.chat_coming_soon")}
          disabled
          testId="app-rail-chat-placeholder"
        >
          <MessageCircleMore className="size-5" strokeWidth={1.8} />
        </RailButton>
      </nav>

      <div className="mt-auto">
        <RailButton
          label={t("navigation.settings")}
          active={props.settingsActive}
          onClick={props.onOpenSettings}
          testId="app-rail-settings"
        >
          <Settings className="size-5" strokeWidth={1.8} />
        </RailButton>
      </div>
    </aside>
  );
}
