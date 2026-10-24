import { FilePlus2, Presentation } from "lucide-react";

import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { t } from "@/i18n";

export function OfficeCreateItems({
  onCreate,
}: {
  onCreate: (kind: "docx" | "pptx") => void;
}) {
  return (
    <>
      <DropdownMenuItem onClick={() => onCreate("docx")}>
        <FilePlus2 />
        {t("file_window.word")}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => onCreate("pptx")}>
        <Presentation />
        PowerPoint
      </DropdownMenuItem>
    </>
  );
}
