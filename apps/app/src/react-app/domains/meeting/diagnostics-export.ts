import { saveFileContent } from "@/app/lib/desktop";
import { meetingDiagnosticsJson } from "./diagnostics";
export async function exportMeetingDiagnostics() {
  const report = JSON.parse(meetingDiagnosticsJson());
  if (window.__JUGGLEWORK_ELECTRON__?.invokeDesktop) {
    try { report.native = await window.__JUGGLEWORK_ELECTRON__.invokeDesktop("meetingDiagnosticsGet"); }
    catch { report.native = { unavailable: true }; }
  }
  const text = JSON.stringify(report, null, 2);
  const name = `meeting-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  if (window.__JUGGLEWORK_ELECTRON__?.invokeDesktop) {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    await saveFileContent({ title: "导出会议诊断", defaultPath: name,
      filters: [{ name: "会议诊断", extensions: ["json"] }], dataBase64: btoa(binary) });
    return;
  }
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a"); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
