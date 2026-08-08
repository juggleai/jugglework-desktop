/** @jsxImportSource react */
import { getResolvedThemeMode } from "@/app/theme";
import { Checkbox } from "@/components/ui/checkbox";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { t } from "@/i18n";
import type { ReactNode } from "react";
import darkThemePreview from "./assets/dark.png";
import lightThemePreview from "./assets/light.png";
import type { AppearanceViewProps } from "../pages/appearance-view";
import {
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemTitle,
} from "../settings-layout";

type ThemeMode = AppearanceViewProps["themeMode"];

interface ThemeSectionProps
  extends Pick<AppearanceViewProps, "busy" | "themeMode" | "setThemeMode"> {}

export function ThemeSection(props: ThemeSectionProps) {
  const followsSystem = props.themeMode === "system";

  return (
    <LayoutSectionItem className="gap-5">
      <LayoutSectionItemHeader className="w-full">
        <LayoutSectionItemTitle>{t("settings.theme_title")}</LayoutSectionItemTitle>
      </LayoutSectionItemHeader>

      <label className="flex cursor-pointer items-start gap-3 self-stretch">
        <Checkbox
          className="mt-0.5 size-5"
          checked={followsSystem}
          disabled={props.busy}
          onCheckedChange={(checked) => {
            props.setThemeMode(checked ? "system" : getResolvedThemeMode());
          }}
        />
        <span className="min-w-0">
          <span className="block text-sm font-medium text-dls-text">
            {t("settings.theme_system")}
          </span>
          <LayoutSectionItemDescription className="mt-1">
            {t("settings.theme_system_hint")}
          </LayoutSectionItemDescription>
        </span>
      </label>

      <ThemePicker
        busy={props.busy}
        themeMode={props.themeMode}
        setThemeMode={props.setThemeMode}
      />
    </LayoutSectionItem>
  );
}

interface ThemePickerProps {
  busy: boolean;
  themeMode: ThemeMode;
  setThemeMode: (value: ThemeMode) => void;
}

function ThemePicker(props: ThemePickerProps) {
  return (
    <ToggleGroup
      value={props.themeMode === "system" ? [] : [props.themeMode]}
      onValueChange={(value) => {
        if (value[0] === "light" || value[0] === "dark") props.setThemeMode(value[0]);
      }}
      disabled={props.busy}
      className="grid w-full max-w-5xl grid-cols-1 justify-start gap-5 sm:grid-cols-2"
    >
      <ThemePickerItem value="light" label={t("settings.theme_light")}>
        <ThemePreview value="light" />
        <ThemePickerLabel>{t("settings.theme_light")}</ThemePickerLabel>
      </ThemePickerItem>
      <ThemePickerItem value="dark" label={t("settings.theme_dark")}>
        <ThemePreview value="dark" />
        <ThemePickerLabel>{t("settings.theme_dark")}</ThemePickerLabel>
      </ThemePickerItem>
    </ToggleGroup>
  );
}

function ThemePickerItem(props: { value: "light" | "dark"; label: string; children: ReactNode }) {
  return (
    <ToggleGroupItem
      value={props.value}
      aria-label={props.label}
      className="group/theme h-auto w-full min-w-0 flex-col items-stretch self-start overflow-hidden rounded-xl border border-dls-border bg-dls-surface p-0 text-left hover:bg-dls-surface aria-pressed:border-primary aria-pressed:bg-primary/5 aria-pressed:shadow-sm"
    >
      {props.children}
    </ToggleGroupItem>
  );
}

function ThemePreview(props: { value: "light" | "dark" }) {
  return (
    <img
      aria-hidden="true"
      alt=""
      src={props.value === "dark" ? darkThemePreview : lightThemePreview}
      className="block aspect-[944/416] w-full shrink-0 scale-[1.01] object-cover object-left-top blur-[1.5px]"
    />
  );
}

function ThemePickerLabel(props: { children: string }) {
  return (
    <span className="flex w-full items-center justify-start gap-3 px-4 py-3.5 text-left text-sm font-medium text-dls-text">
      <span className="flex size-4 items-center justify-center rounded-full border border-dls-border-strong group-data-pressed/theme:border-primary">
        <span className="size-2 rounded-full bg-primary opacity-0 group-data-pressed/theme:opacity-100" />
      </span>
      {props.children}
    </span>
  );
}
