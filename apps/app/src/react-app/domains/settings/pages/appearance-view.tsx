/** @jsxImportSource react */
import type { Language } from "@/i18n";
import { Separator } from "@/components/ui/separator";
import { LanguageSection } from "../appearance/language-section";
import { ThemeSection } from "../appearance/theme-section";
import { LayoutStack } from "../settings-layout";

export type AppearanceViewProps = {
  busy: boolean;
  themeMode: "light" | "dark" | "system";
  setThemeMode: (value: "light" | "dark" | "system") => void;
  language: Language;
  setLanguage: (value: Language) => void;
};

export function AppearanceView(props: AppearanceViewProps) {
  return (
    <LayoutStack>
      <ThemeSection {...props} />
      <Separator />
      <LanguageSection {...props} />
    </LayoutStack>
  );
}
