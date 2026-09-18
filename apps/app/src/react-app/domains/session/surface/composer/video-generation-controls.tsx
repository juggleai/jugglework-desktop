/** @jsxImportSource react */
import { useState } from "react";
import { ChevronDown, ChevronRight, MoreHorizontal, SlidersHorizontal, Sparkles, SquarePlay, X } from "lucide-react";

import type {
  ComposerVideoAspectRatio,
  ComposerVideoGenerationOptions,
} from "@/app/types";
import { t } from "@/i18n";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import {
  VIDEO_ASPECT_RATIO_OPTIONS,
  VIDEO_DURATION_MAX_SECONDS,
  VIDEO_DURATION_MIN_SECONDS,
  videoModelKey,
  type ComposerVideoModelOption,
} from "./video-generation";

type VideoGenerationControlsProps = {
  models: ComposerVideoModelOption[];
  value: ComposerVideoGenerationOptions;
  disabled?: boolean;
  onChange: (value: ComposerVideoGenerationOptions) => void;
  onClose: () => void;
};

const triggerClassName = "h-8 max-w-[15rem] gap-1.5 border-0 bg-transparent px-2 text-xs text-gray-11 shadow-none hover:bg-gray-3 hover:text-gray-12 focus-visible:ring-2 focus-visible:ring-gray-7";

function aspectRatioLabel(value: ComposerVideoAspectRatio) {
  return value === "auto" ? t("composer.video_generation_auto") : value;
}

function AspectRatioIcon({ value }: { value: ComposerVideoAspectRatio }) {
  if (value === "auto") {
    return (
      <span className="relative block h-5 w-6" aria-hidden="true">
        <span className="absolute left-0.5 top-0.5 h-3.5 w-4 rounded-[3px] border-[1.5px] border-current opacity-60" />
        <span className="absolute bottom-0 right-0 h-3.5 w-4 rounded-[3px] border-[1.5px] border-current" />
      </span>
    );
  }
  const [width, height] = value.split(":").map(Number);
  const landscape = width > height;
  const square = width === height;
  return (
    <span
      className={`block rounded-[3px] border-[1.5px] border-current ${square ? "h-4 w-4" : landscape ? "h-3 w-5" : "h-5 w-3"}`}
      aria-hidden="true"
    />
  );
}

function VideoSettingsContent({
  value,
  onChange,
}: Pick<VideoGenerationControlsProps, "value" | "onChange">) {
  const durationProgress = (
    (value.durationSeconds - VIDEO_DURATION_MIN_SECONDS)
    / (VIDEO_DURATION_MAX_SECONDS - VIDEO_DURATION_MIN_SECONDS)
  ) * 100;

  return (
    <PopoverContent
      side="top"
      align="end"
      sideOffset={10}
      className="max-h-(--available-height) w-[min(23rem,calc(100vw-1.5rem))] gap-5 overflow-y-auto rounded-xl border border-dls-border bg-dls-surface p-3 shadow-[var(--dls-shell-shadow)]"
    >
      <section aria-labelledby="video-aspect-ratio-title">
        <h3 id="video-aspect-ratio-title" className="mb-2 text-xs font-medium text-gray-9">
          {t("composer.video_generation_ratio")}
        </h3>
        <div className="grid grid-cols-4 gap-2">
          {VIDEO_ASPECT_RATIO_OPTIONS.map((ratio) => {
            const selected = value.aspectRatio === ratio;
            return (
              <button
                key={ratio}
                type="button"
                aria-pressed={selected}
                onClick={() => onChange({ ...value, aspectRatio: ratio })}
                className={`flex h-14 flex-col items-center justify-center gap-1.5 rounded-lg border text-xs transition-colors ${selected ? "border-blue-9 bg-gray-4 text-blue-10 ring-1 ring-blue-9" : "border-transparent bg-gray-2 text-gray-11 hover:bg-gray-3"}`}
              >
                <AspectRatioIcon value={ratio} />
                <span className={selected ? "text-blue-10" : "text-gray-12"}>{aspectRatioLabel(ratio)}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="video-duration-title">
        <h3 id="video-duration-title" className="text-xs font-medium text-gray-9">
          {t("composer.video_generation_duration")}
        </h3>
        <div className="relative pt-7">
          <output
            className="absolute top-0 w-8 -translate-x-1/2 text-center text-xs font-medium tabular-nums text-gray-12"
            style={{ left: `${durationProgress}%` }}
          >
            {value.durationSeconds}s
          </output>
          <input
            type="range"
            min={VIDEO_DURATION_MIN_SECONDS}
            max={VIDEO_DURATION_MAX_SECONDS}
            step={1}
            value={value.durationSeconds}
            onChange={(event) => onChange({ ...value, durationSeconds: Number(event.currentTarget.value) })}
            aria-label={t("composer.video_generation_duration")}
            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-gray-5 outline-none focus-visible:ring-2 focus-visible:ring-blue-8 [&::-moz-range-thumb]:size-5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border [&::-moz-range-thumb]:border-gray-7 [&::-moz-range-thumb]:bg-gray-4 [&::-webkit-slider-thumb]:-mt-[7px] [&::-webkit-slider-thumb]:size-5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-gray-7 [&::-webkit-slider-thumb]:bg-gray-4 [&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:rounded-full"
            style={{ background: `linear-gradient(to right, var(--blue-9) ${durationProgress}%, var(--gray-5) ${durationProgress}%)` }}
          />
        </div>
        <div className="mt-2 flex justify-between text-xs text-gray-9">
          <span>{VIDEO_DURATION_MIN_SECONDS}s</span>
          <span>{VIDEO_DURATION_MAX_SECONDS}s</span>
        </div>
      </section>
    </PopoverContent>
  );
}

export function VideoGenerationControls({
  models,
  value,
  disabled = false,
  onChange,
  onClose,
}: VideoGenerationControlsProps) {
  const [desktopSettingsOpen, setDesktopSettingsOpen] = useState(false);
  const [mobileOverflowOpen, setMobileOverflowOpen] = useState(false);
  const [mobileSettingsOpen, setMobileSettingsOpen] = useState(false);
  const selectedKey = videoModelKey({
    providerID: value.model.providerID,
    modelID: value.model.modelID,
  });
  const selectedModel = models.find((model) => videoModelKey(model) === selectedKey);

  return (
    <div
      className="mb-2 flex min-w-0 items-center gap-1 overflow-x-auto pb-0.5"
      data-testid="video-generation-controls"
    >
      <div className="flex h-8 shrink-0 items-center gap-1.5 rounded-xl bg-blue-3 px-2.5 text-xs font-medium text-blue-11">
        <SquarePlay size={15} strokeWidth={1.8} />
        <span>{t("composer.video_generation")}</span>
        <button
          type="button"
          className="-mr-1 inline-flex size-6 items-center justify-center rounded-lg text-blue-9 transition-colors hover:bg-blue-4 hover:text-blue-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-7"
          onClick={onClose}
          aria-label={t("composer.video_generation_close")}
          title={t("composer.video_generation_close")}
        >
          <X size={14} />
        </button>
      </div>

      <Select
        value={selectedKey}
        onValueChange={(nextKey) => {
          const model = models.find((candidate) => videoModelKey(candidate) === nextKey);
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
          aria-label={t("composer.video_generation_model")}
        >
          <Sparkles size={15} strokeWidth={1.8} />
          <span className="text-gray-10">{t("composer.video_generation_model")}</span>
          <span className="max-w-32 truncate font-medium text-gray-12">
            {selectedModel?.modelName ?? value.modelName}
          </span>
        </SelectTrigger>
        <SelectContent side="top" sideOffset={8} align="start" className="min-w-64">
          <SelectGroup>
            {models.map((model) => (
              <SelectItem key={videoModelKey(model)} value={videoModelKey(model)}>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{model.modelName}</span>
                  <span className="truncate text-[11px] font-normal text-gray-9">{model.providerName}</span>
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>

      <div className="hidden sm:block">
        <Popover open={desktopSettingsOpen} onOpenChange={setDesktopSettingsOpen}>
          <PopoverTrigger
            render={
              <button
                type="button"
                disabled={disabled}
                aria-label={t("composer.video_generation_settings")}
                aria-expanded={desktopSettingsOpen}
                className={`${triggerClassName} inline-flex w-[7.75rem] shrink-0 items-center justify-center rounded-md disabled:pointer-events-none disabled:opacity-60`}
              >
                <SlidersHorizontal size={15} strokeWidth={1.8} />
                <span className="w-[4.125rem] text-center font-medium tabular-nums text-gray-12">
                  {aspectRatioLabel(value.aspectRatio)} · {value.durationSeconds}s
                </span>
                <ChevronDown size={14} className={`transition-transform ${desktopSettingsOpen ? "rotate-180" : ""}`} />
              </button>
            }
          />
          <VideoSettingsContent value={value} onChange={onChange} />
        </Popover>
      </div>

      <div className="sm:hidden">
        <Popover open={mobileOverflowOpen} onOpenChange={setMobileOverflowOpen}>
          <PopoverTrigger
            render={
              <button
                type="button"
                disabled={disabled}
                aria-label={t("composer.video_generation_settings")}
                aria-expanded={mobileOverflowOpen}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-gray-11 transition-colors hover:bg-gray-3 hover:text-gray-12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-7 disabled:pointer-events-none disabled:opacity-60"
              >
                <MoreHorizontal size={18} />
              </button>
            }
          />
          <PopoverContent
            side="top"
            align="end"
            sideOffset={8}
            className="w-36 gap-0 rounded-xl border border-dls-border bg-dls-surface p-1.5 shadow-[var(--dls-shell-shadow)]"
          >
            <Popover open={mobileSettingsOpen} onOpenChange={setMobileSettingsOpen}>
              <PopoverTrigger
                render={
                  <button
                    type="button"
                    aria-label={t("composer.video_generation_settings")}
                    aria-expanded={mobileSettingsOpen}
                    className="flex h-10 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm text-gray-12 transition-colors hover:bg-gray-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-7"
                  >
                    <SlidersHorizontal size={16} strokeWidth={1.8} className="shrink-0 text-gray-10" />
                    <span className="min-w-0 flex-1 truncate font-medium tabular-nums">
                      {aspectRatioLabel(value.aspectRatio)} · {value.durationSeconds}s
                    </span>
                    <ChevronRight size={15} className="shrink-0 text-gray-9" />
                  </button>
                }
              />
              <VideoSettingsContent value={value} onChange={onChange} />
            </Popover>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
