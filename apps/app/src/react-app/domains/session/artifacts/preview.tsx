/** @jsxImportSource react */
import * as React from "react";
import { Loader2 } from "lucide-react";

import { getResolvedThemeMode, subscribeToTheme } from "@/app/theme";
import { cn } from "@/lib/utils";
import { MarkdownBlock } from "../surface/markdown";

interface PreviewLoadingProps extends React.ComponentProps<"div"> {}

export function PreviewLoading({ className, ...props }: PreviewLoadingProps) {
  return (
    <div className={cn("flex h-full items-center justify-center text-muted-foreground", className)} {...props}>
      <Loader2 className="size-4 animate-spin" />
    </div>
  );
}

interface PreviewErrorProps extends React.ComponentProps<"div"> {
  message: string;
}

export function PreviewError({ message, className, ...props }: PreviewErrorProps) {
  return <div className={cn("p-4 text-sm text-muted-foreground", className)} {...props}>{message}</div>;
}

interface PlainTextProps extends React.ComponentProps<"pre"> {
  content: string;
}

export function PlainText({ content, className, ...props }: PlainTextProps) {
  return <pre className={cn("h-full overflow-auto p-4 text-xs leading-5 text-foreground whitespace-pre-wrap", className)} {...props}>{content}</pre>;
}

interface MarkdownPreviewProps extends React.ComponentProps<"div"> {
  content: string;
}

export function MarkdownPreview({ content, className, ...props }: MarkdownPreviewProps) {
  const themeMode = React.useSyncExternalStore(subscribeToTheme, getResolvedThemeMode, () => "light");

  return (
    <div data-jugglework-markdown-preview="" className={cn("subtle-scrollbar h-full overflow-auto px-4 py-6", className)} {...props}>
      <div className="mx-auto w-full max-w-3xl">
        <MarkdownBlock text={content} copyCodeBlocks mermaidTheme={themeMode === "dark" ? "dark" : "default"} />
      </div>
    </div>
  );
}

interface HTMLPreviewProps {
  title: string;
  content: string;
  className?: string;
}

export const HTML_PREVIEW_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "worker-src 'none'",
  "script-src 'unsafe-inline' blob:",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data: blob:",
  "media-src data: blob:",
  "navigate-to 'none'",
].join("; ");

function escapeHTMLAttribute(value: string) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

export function createHTMLPreviewDocument(content: string) {
  const policy = escapeHTMLAttribute(HTML_PREVIEW_CSP);
  return `<meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer">${content}`;
}

export function HTMLPreview({ className, title, content }: HTMLPreviewProps) {
  return (
    <iframe
      srcDoc={createHTMLPreviewDocument(content)}
      title={title}
      className={cn("h-full w-full border-0", className)}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
    />
  );
}

interface PdfPreviewProps {
  url: string;
  title: string;
  className?: string;
}

export function PdfPreview({ url, title, className }: PdfPreviewProps) {
  // Chromium's built-in PDF viewer (enabled via webPreferences.plugins) renders
  // reliably through <embed>; <object>/sandboxed <iframe> show a blank frame.
  // The blob URL comes from a trusted workspace file.
  return <embed src={url} type="application/pdf" title={title} className={cn("h-full w-full border-0", className)} />;
}

interface ImagePreviewProps extends React.ComponentProps<"div"> {
  src: string;
  alt: string;
}

export function ImagePreview({ src, alt, className, ...props }: ImagePreviewProps) {
  return (
    <div className={cn("flex h-full items-center justify-center overflow-auto bg-muted/30 p-3", className)} {...props}>
      <img src={src} alt={alt} className="max-h-full max-w-full object-contain" />
    </div>
  );
}

export function VideoPreview({ src, title, className }: { src: string; title: string; className?: string }) {
  return (
    <div className={cn("flex h-full items-center justify-center overflow-auto bg-black p-3", className)}>
      <video src={src} title={title} controls preload="metadata" className="max-h-full max-w-full" />
    </div>
  );
}

interface PreviewUnavailableProps extends React.ComponentProps<"div"> {}

export function PreviewUnavailable({ className, ...props }: PreviewUnavailableProps) {
  return <div className={cn("p-4 text-sm text-muted-foreground", className)} {...props}>Preview unavailable. Open externally to view this file.</div>;
}
