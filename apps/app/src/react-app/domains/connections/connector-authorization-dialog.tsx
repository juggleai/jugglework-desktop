/** @jsxImportSource react */
import { ArrowUpRight, CheckCircle2, Github, GitPullRequestArrow, LoaderCircle, Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { currentLocale } from "@/i18n";

const text = (en: string, zh: string) => currentLocale() === "zh" ? zh : en;

export type ConnectorAuthorizationProps = {
  name: string;
  approvedByOrganization?: boolean;
  busy?: boolean;
  error?: string | null;
  onContinue: () => void;
};

/** Shared by Code Review and connector list/detail actions. */
export function ConnectorAuthorizationContent(props: ConnectorAuthorizationProps) {
  const github = props.name.trim().toLowerCase() === "github";
  return <>
    <div className="flex items-center justify-center gap-4 pt-2" aria-hidden="true">
      <div className="flex size-16 items-center justify-center rounded-2xl bg-black text-white"><GitPullRequestArrow className="size-9" /></div>
      <span className="tracking-[5px] text-dls-border">•••</span>
      <div className="flex size-16 items-center justify-center rounded-2xl border border-dls-border bg-white text-black">{github ? <Github className="size-11" /> : <Plug className="size-11" />}</div>
    </div>
    <div className="text-center">
      <DialogTitle className="text-2xl font-semibold">{text(`Connect ${props.name}`, `连接 ${props.name}`)}</DialogTitle>
      <DialogDescription className="mt-2">{text(`Connect your ${props.name} account to JuggleWork`, `将你的 ${props.name} 账号连接到 JuggleWork`)}</DialogDescription>
      {props.approvedByOrganization ? <p className="mt-5 flex items-center justify-center gap-2 text-green-11"><CheckCircle2 className="size-4" />{text("Approved by your organization", "已由组织批准")}</p> : null}
    </div>
    <div className="divide-y divide-dls-border rounded-2xl border border-dls-border px-5 text-sm">
      {[
        [text("Respect your permissions", "始终遵守权限"), text(`${props.name} controls which resources this account can access. You can revoke authorization in ${props.name} at any time.`, `${props.name} 根据你授权的权限开放资源访问。你可以随时在 ${props.name} 中撤销授权。`)],
        [text("How JuggleWork uses this connection", "JuggleWork 如何使用连接"), github
          ? text("Code Review uses your organization's connector to load pull requests, changes, checks, and review threads.", "代码评审通过组织连接器读取 Pull Request、代码变更、检查结果和评审讨论。")
          : text("JuggleWork uses this connector to access the resources and tools you authorize.", "JuggleWork 通过此连接器访问你授权的资源和工具。")],
        [text("Review access before continuing", "连接前检查访问权限"), text(`Continue to connect ${props.name}. If sign-in is required, review the application and its requested permissions in your browser before authorizing.`, `继续连接 ${props.name}。如需登录，将在浏览器中打开授权页面，请检查应用信息和请求的权限后再授权。`)],
      ].map(([title, description]) => <div key={title} className="py-4"><h3 className="font-semibold">{title}</h3><p className="mt-1.5 leading-6 text-dls-secondary">{description}</p></div>)}
    </div>
    {props.error ? <p role="alert" className="text-sm text-red-11">{props.error}</p> : null}
    <Button className="h-11 w-full rounded-full" disabled={props.busy} onClick={props.onContinue}>
      {props.busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
      {text(`Continue connecting to ${props.name}`, `继续连接到 ${props.name}`)}<ArrowUpRight className="size-4" />
    </Button>
  </>;
}

export function ConnectorAuthorizationDialog(props: ConnectorAuthorizationProps & { open: boolean; onOpenChange: (open: boolean) => void }) {
  return <Dialog open={props.open} onOpenChange={props.onOpenChange}>
    <DialogContent className="max-h-[90vh] overflow-y-auto p-7 sm:max-w-[520px] sm:p-8"><ConnectorAuthorizationContent {...props} /></DialogContent>
  </Dialog>;
}
