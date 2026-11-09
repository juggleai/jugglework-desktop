import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../../", import.meta.url));
export default defineConfig({
  root,
  server: { host: "127.0.0.1", port: 5187, strictPort: true },
  resolve: { alias: { "@": `${root}src` } },
  plugins: [
    {
      name: "meeting-test-provider-boundaries",
      enforce: "pre",
      transform(_code, id) {
        if (id.endsWith("/domains/cloud/den-auth-provider.tsx"))
          return "export function useDenAuth(){return window.__meetingTestAuth}";
        if (id.endsWith("/domains/meeting/im-adapter.ts"))
          return "export async function joinMeetingChatroom(){return {send:async(content)=>({messageId:crypto.randomUUID(),content:{content}}),leave:async()=>{window.__meetingQA.chatLeft++}}}";
      },
    },
    react(),
  ],
});
