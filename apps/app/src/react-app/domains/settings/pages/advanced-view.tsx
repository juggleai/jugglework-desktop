/** @jsxImportSource react */
import { Switch } from "@/components/ui/switch";
import { t } from "@/i18n";
import {
  LayoutSection,
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
  LayoutStack,
} from "../settings-layout";

export type AdvancedViewProps = {
  busy: boolean;
  developerMode: boolean;
  toggleDeveloperMode: () => void;
};

export function AdvancedView(props: AdvancedViewProps) {
  return (
    <LayoutStack>
      <LayoutSection>
        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>{t("settings.developer_mode_title")}</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>{t("settings.developer_mode_desc")}</LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <Switch
                aria-label={t("settings.developer_mode_title")}
                checked={props.developerMode}
                disabled={props.busy}
                onCheckedChange={props.toggleDeveloperMode}
              />
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
        </LayoutSectionItem>
      </LayoutSection>
    </LayoutStack>
  );
}
