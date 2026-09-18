/** @jsxImportSource react */
import { Image as ImageIcon, Palette, SlidersHorizontal, Sparkles, X } from "lucide-react";

import type {
  ComposerImageAspectRatio,
  ComposerImageGenerationOptions,
  ComposerImageStyle,
} from "@/app/types";
import { t } from "@/i18n";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import {
  IMAGE_ASPECT_RATIO_OPTIONS,
  IMAGE_STYLE_OPTIONS,
  imageModelKey,
  type ComposerImageModelOption,
} from "./image-generation";

type ImageGenerationControlsProps = {
  models: ComposerImageModelOption[];
  value: ComposerImageGenerationOptions;
  disabled?: boolean;
  onChange: (value: ComposerImageGenerationOptions) => void;
  onClose: () => void;
};

function aspectRatioLabel(value: ComposerImageAspectRatio) {
  return value === "auto" ? t("composer.image_generation_auto") : value;
}

function styleLabel(value: ComposerImageStyle) {
  return t(`composer.image_generation_style_${value}`);
}

const triggerClassName = "h-8 max-w-[15rem] gap-1.5 border-0 bg-transparent px-2 text-xs text-gray-11 shadow-none hover:bg-gray-3 hover:text-gray-12 focus-visible:ring-2 focus-visible:ring-gray-7";

export function ImageGenerationControls({
  models,
  value,
  disabled = false,
  onChange,
  onClose,
}: ImageGenerationControlsProps) {
  const selectedKey = imageModelKey({
    providerID: value.model.providerID,
    modelID: value.model.modelID,
  });
  const selectedModel = models.find((model) => imageModelKey(model) === selectedKey);

  return (
    <div
      className="mb-2 flex min-w-0 items-center gap-1 overflow-x-auto pb-0.5"
      data-testid="image-generation-controls"
    >
      <div className="flex h-8 shrink-0 items-center gap-1.5 rounded-xl bg-blue-3 px-2.5 text-xs font-medium text-blue-11">
        <ImageIcon size={15} strokeWidth={1.8} />
        <span>{t("composer.image_generation")}</span>
        <button
          type="button"
          className="-mr-1 inline-flex size-6 items-center justify-center rounded-lg text-blue-9 transition-colors hover:bg-blue-4 hover:text-blue-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-7"
          onClick={onClose}
          aria-label={t("composer.image_generation_close")}
          title={t("composer.image_generation_close")}
        >
          <X size={14} />
        </button>
      </div>

      <Select
        value={selectedKey}
        onValueChange={(nextKey) => {
          const model = models.find((candidate) => imageModelKey(candidate) === nextKey);
          if (!model) return;
          onChange({
            ...value,
            model: { providerID: model.providerID, modelID: model.modelID },
            modelName: model.modelName,
            providerName: model.providerName,
          });
        }}
        disabled={disabled}
      >
        <SelectTrigger
          size="sm"
          className={triggerClassName}
          aria-label={t("composer.image_generation_model")}
        >
          <Sparkles size={15} strokeWidth={1.8} />
          <span className="text-gray-10">{t("composer.image_generation_model")}</span>
          <span className="max-w-32 truncate font-medium text-gray-12">
            {selectedModel?.modelName ?? value.modelName}
          </span>
        </SelectTrigger>
        <SelectContent side="top" sideOffset={8} align="start" className="min-w-64">
          <SelectGroup>
            {models.map((model) => (
              <SelectItem key={imageModelKey(model)} value={imageModelKey(model)}>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{model.modelName}</span>
                  <span className="truncate text-[11px] font-normal text-gray-9">{model.providerName}</span>
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>

      <Select
        value={value.aspectRatio}
        onValueChange={(nextValue) => onChange({
          ...value,
          aspectRatio: nextValue as ComposerImageAspectRatio,
        })}
        disabled={disabled}
      >
        <SelectTrigger
          size="sm"
          className={triggerClassName}
          aria-label={t("composer.image_generation_ratio")}
        >
          <SlidersHorizontal size={15} strokeWidth={1.8} />
          <span className="text-gray-10">{t("composer.image_generation_ratio")}</span>
          <span className="font-medium text-gray-12">{aspectRatioLabel(value.aspectRatio)}</span>
        </SelectTrigger>
        <SelectContent side="top" sideOffset={8} align="start" className="min-w-40">
          <SelectGroup>
            {IMAGE_ASPECT_RATIO_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {aspectRatioLabel(option.value)}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>

      <Select
        value={value.style}
        onValueChange={(nextValue) => onChange({
          ...value,
          style: nextValue as ComposerImageStyle,
        })}
        disabled={disabled}
      >
        <SelectTrigger
          size="sm"
          className={triggerClassName}
          aria-label={t("composer.image_generation_style")}
        >
          <Palette size={15} strokeWidth={1.8} />
          <span className="text-gray-10">{t("composer.image_generation_style")}</span>
          <span className="font-medium text-gray-12">{styleLabel(value.style)}</span>
        </SelectTrigger>
        <SelectContent side="top" sideOffset={8} align="start" className="min-w-44">
          <SelectGroup>
            {IMAGE_STYLE_OPTIONS.map((style) => (
              <SelectItem key={style} value={style}>
                {styleLabel(style)}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  );
}
