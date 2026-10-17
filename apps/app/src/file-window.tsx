import * as React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { bootstrapTheme } from "@/app/theme";
import { initLocale } from "@/i18n";
import {
  createDefaultPlatform,
  PlatformProvider,
} from "@/react-app/kernel/platform";
import { FileWindowApp } from "@/react-app/domains/session/files/file-window-app";
import "./app/index.css";
import "./react-app/domains/session/files/file-window.css";

bootstrapTheme();
initLocale();
const root = document.getElementById("root");
if (!root) throw new Error("文件窗口容器不存在");
createRoot(root).render(
  <QueryClientProvider client={new QueryClient()}>
    <TooltipProvider>
      <PlatformProvider value={createDefaultPlatform()}>
        <FileWindowApp />
        <Toaster />
      </PlatformProvider>
    </TooltipProvider>
  </QueryClientProvider>,
);
