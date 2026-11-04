import * as React from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { getReactQueryClient } from "@/react-app/infra/query-client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { applyFileWindowAppearance } from "@/app/lib/file-window-appearance";
import {
  createDefaultPlatform,
  PlatformProvider,
} from "@/react-app/kernel/platform";
import { FileWindowApp } from "@/react-app/domains/session/files/file-window-app";
import "./app/index.css";
import "./react-app/domains/session/files/file-window.css";

applyFileWindowAppearance();
const root = document.getElementById("root");
if (!root) throw new Error("文件窗口容器不存在");
createRoot(root).render(
  <QueryClientProvider client={getReactQueryClient()}>
    <TooltipProvider>
      <PlatformProvider value={createDefaultPlatform()}>
        <FileWindowApp onAppearanceChange={applyFileWindowAppearance} />
        <Toaster />
      </PlatformProvider>
    </TooltipProvider>
  </QueryClientProvider>,
);
