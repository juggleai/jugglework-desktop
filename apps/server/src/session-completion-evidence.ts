/** Only the latest assistant in this run can prove successful completion. */
export function hasCurrentRunFinalResponse(messages: unknown, startedAt: number): boolean {
  if (!Array.isArray(messages)) return false;
  const assistants = messages.flatMap((message) => {
    const info = message?.info;
    return info?.role === "assistant" ? [info] : [];
  });
  const latest = assistants.sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0)).at(-1);
  return Boolean(latest && latest.summary !== true &&
    !latest.error &&
    typeof latest.time?.created === "number" && latest.time.created >= startedAt &&
    typeof latest.time?.completed === "number" &&
    (latest.finish === "stop" || latest.finish === "end_turn"));
}
