import { isFileWindowRuntime } from "@/app/lib/runtime-env";
import { useJuggleWorkServer } from "../connections/jugglework-server-provider";
import { CloudDocsApiResponder } from "./cloud-docs-api-responder";
import { FileWindowUploadRelay } from "./use-cloud-upload";

/** 根层只保留一份请求监听；导航或关闭文件面板不影响上传、分享查找和后台 AI 请求。 */
export function CloudDocsCoordinator() {
  const store = useJuggleWorkServer();
  if (isFileWindowRuntime()) return null;
  const client = store.getSnapshot().juggleworkServerClient;
  return <><CloudDocsApiResponder client={client} /><FileWindowUploadRelay client={client} /></>;
}
