/** @jsxImportSource react */
import { ArrowRight, KeyRound, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ProviderIcon } from "../../design-system/provider-icon";
import {
  JUGGLEWORK_MODELS_PROVIDER_ID,
  JUGGLEWORK_MODELS_PROVIDER_NAME,
  type JuggleWorkModelPreview,
} from "./jugglework-models-promo";

type JuggleWorkModelsStartupDialogProps = {
  open: boolean;
  isSignedIn: boolean;
  models: JuggleWorkModelPreview[];
  onSubscribe: () => void;
  onContinueWithout: () => void;
};

export function JuggleWorkModelsStartupDialog(props: JuggleWorkModelsStartupDialogProps) {
  const featuredModels = props.models.slice(0, 3);

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onContinueWithout();
      }}
    >
      <DialogContent className="w-full max-w-lg overflow-hidden sm:max-w-lg">
        <DialogHeader>
          <div className="mb-2 flex size-11 items-center justify-center rounded-2xl border border-blue-6 bg-blue-2 text-blue-11">
            <ProviderIcon providerId={JUGGLEWORK_MODELS_PROVIDER_ID} providerName={JUGGLEWORK_MODELS_PROVIDER_NAME} size={22} />
          </div>
          <DialogTitle>{t("models_startup.title")}</DialogTitle>
          <DialogDescription>
            {t("models_startup.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-3">
            {featuredModels.map((model) => (
              <div key={model.id} className="rounded-xl border border-dls-border bg-dls-surface px-3 py-2">
                <div className="truncate text-xs font-medium text-dls-text">{model.title}</div>
                <div className="mt-0.5 truncate text-[11px] text-dls-secondary">{model.subtitle}</div>
              </div>
            ))}
          </div>

          <div className="grid gap-2 text-xs text-dls-secondary sm:grid-cols-2">
            <div className="flex gap-2 rounded-xl bg-dls-hover/50 p-3">
              <Sparkles className="mt-0.5 size-3.5 shrink-0 text-blue-11" />
              <span>{t("models_startup.managed_access")}</span>
            </div>
            <div className="flex gap-2 rounded-xl bg-dls-hover/50 p-3">
              <KeyRound className="mt-0.5 size-3.5 shrink-0 text-blue-11" />
              <span>{t("models_startup.no_api_keys")}</span>
            </div>
          </div>

          <p className="text-xs text-dls-secondary">
            {t("models_startup.pricing")}
          </p>
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" onClick={props.onContinueWithout}>
            {t("models_startup.continue_without")}
          </Button>
          <Button onClick={props.onSubscribe}>
            {props.isSignedIn ? t("models_startup.subscribe") : t("models_startup.sign_in_to_subscribe")}
            <ArrowRight className="ml-1.5 size-3.5" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
