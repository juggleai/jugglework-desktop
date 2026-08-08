/** @jsxImportSource react */
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const SUPPORT_EMAIL = "team@juggle.im";
const SUPPORT_MAILTO = `mailto:${SUPPORT_EMAIL}?subject=JuggleWork%20Den%20remote%20worker%20upgrade`;

/**
 * Small inline link rendered inside the remote-worker error card. When clicked,
 * it opens a dialog explaining the JuggleWork Den upgrade situation and how to
 * reach support.
 */
export function JuggleWorkDenHelpLink() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="mt-2 inline-flex items-center text-[11px] font-medium text-blue-11 underline-offset-2 hover:underline"
        onClick={() => setOpen(true)}
      >
        {t("den_help.link")}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("den_help.title")}</DialogTitle>
            <DialogDescription>
              {t("den_help.description")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 text-[13px] leading-5 text-gray-11">
            <p>{t("den_help.options_intro")}</p>
            <ul className="ml-4 list-disc space-y-2">
              <li>
                {t("den_help.email_prefix")}{" "}
                <a
                  href={SUPPORT_MAILTO}
                  className="font-medium text-blue-11 hover:underline"
                >
                  {SUPPORT_EMAIL}
                </a>{" "}
                {t("den_help.email_suffix")}
              </li>
              <li>
                {t("den_help.feedback_prefix")}{" "}
                <span className="font-medium text-dls-text">{t("den_help.feedback")}</span>{" "}
                {t("den_help.feedback_suffix")}
              </li>
            </ul>
          </div>

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              {t("common.close")}
            </DialogClose>
            <Button
              type="button"
              onClick={() => {
                window.location.href = SUPPORT_MAILTO;
              }}
            >
              {t("den_help.email_support")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
