/** @jsxImportSource react */
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ALL_LANGUAGE_OPTIONS, LANGUAGE_OPTIONS, t } from "@/i18n";
import type { AppearanceViewProps } from "../pages/appearance-view";
import {
  LayoutSectionItem,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
} from "../settings-layout";

interface LanguageSectionProps extends Pick<AppearanceViewProps, "busy" | "language" | "setLanguage"> {}

export function LanguageSection(props: LanguageSectionProps) {
  // TIPS: 只提供中/英两个选项，但若用户此前存过其他语言（语言包仍保留），
  // 把当前语言补进列表，否则选择器会显示为空白且看不出正在用什么语言。
  const options = LANGUAGE_OPTIONS.some((option) => option.value === props.language)
    ? LANGUAGE_OPTIONS
    : [
        ...LANGUAGE_OPTIONS,
        ...ALL_LANGUAGE_OPTIONS.filter((option) => option.value === props.language),
      ];

  return (
    <LayoutSectionItem>
      <LayoutSectionItemHeader className="items-center">
        <LayoutSectionItemTitle>{t("settings.language")}</LayoutSectionItemTitle>

        <LayoutSectionItemHeaderActions className="self-center">
          <div className="w-64 max-w-full">
            <Select
              value={props.language}
              items={options}
              onValueChange={(value) => {
                if (value) props.setLanguage(value);
              }}
              disabled={props.busy}
            >
              <SelectTrigger className="w-full" aria-label={t("settings.language")}>
                <SelectValue placeholder={t("settings.language")} />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {options.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.nativeName}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        </LayoutSectionItemHeaderActions>
      </LayoutSectionItemHeader>
    </LayoutSectionItem>
  );
}
