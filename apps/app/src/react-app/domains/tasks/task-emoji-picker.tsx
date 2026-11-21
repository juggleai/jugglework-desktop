import * as React from "react";
import { t } from "@/i18n";

const emojis = "🆗 👍 🙏 💪 🫰 👏 🤜 ➕ ✅ 🙂 😊 😄 😁 😆 😌 😂 🤦 🥰 😜 😎 🤔 🧐 😮 🙃 😭 🤭 😅 🤫 😑 🤣 😘 🫣 🥲 🌚 🌝 🐶 🐱 🌹 ❤️ 🎉 🤓 😔 🤗 😋 🤩 😬 ✌️ 🥹 😇 🥳 😚 😍 😻 🤑 😉 🙌 💡 🎯 🚀 🔥 💯 👀 💖 🌟 🏆 🎈 🤝 🥺 😴 😱 👌 ✨".split(" ");
const defaults = "🆗 🤦 😂 ✅ 🐶 🤭 😭 🫰 👍 🙌 🤜 ➕ 🎉 🥰".split(" ");
const key = "tasks.description.emoji-counts.v1";
function counts(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "{}");
    return Object.fromEntries(emojis.filter(e => Number.isSafeInteger(raw?.[e]) && raw[e] > 0).map(e => [e, raw[e]]));
  } catch { return {}; }
}

export function emojiPlacement(anchor: { top: number; bottom: number }, visibleTop: number, visibleBottom: number) {
  const below = Math.max(0, visibleBottom - anchor.bottom - 8);
  const above = Math.max(0, anchor.top - visibleTop - 8);
  const flip = below < 336 && above > below;
  return { above: flip, maxHeight: Math.min(336, flip ? above : below) };
}

function usePickerPlacement(anchor: React.RefObject<HTMLElement | null>) {
  const [placement, setPlacement] = React.useState({ above: false, maxHeight: 336 });
  React.useLayoutEffect(() => {
    const toolbar = anchor.current;
    if (!toolbar) return;
    const clippers: HTMLElement[] = [];
    for (let el = toolbar.parentElement; el; el = el.parentElement) {
      if (/^(auto|scroll|hidden|clip|overlay)$/.test(getComputedStyle(el).overflowY)) clippers.push(el);
    }
    const viewport = window.visualViewport;
    function measure() {
      let top = viewport?.offsetTop ?? 0;
      let bottom = top + (viewport?.height ?? window.innerHeight);
      for (const el of clippers) {
        const edge = el.getBoundingClientRect().top + el.clientTop;
        top = Math.max(top, edge);
        bottom = Math.min(bottom, edge + el.clientHeight);
      }
      const next = emojiPlacement(toolbar!.getBoundingClientRect(), top, bottom);
      setPlacement(prev => prev.above === next.above && prev.maxHeight === next.maxHeight ? prev : next);
    }
    measure();
    const observer = new ResizeObserver(measure);
    for (const el of [toolbar, ...clippers]) observer.observe(el);
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    viewport?.addEventListener("resize", measure);
    viewport?.addEventListener("scroll", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
      viewport?.removeEventListener("resize", measure);
      viewport?.removeEventListener("scroll", measure);
    };
  }, [anchor]);
  return placement;
}

export function TaskEmojiPicker({ anchor, onPick, onCancel }: { anchor: React.RefObject<HTMLElement | null>; onPick: (value: string) => void; onCancel: () => void }) {
  const { above, maxHeight } = usePickerPlacement(anchor);
  const first = React.useRef<HTMLButtonElement>(null);
  React.useLayoutEffect(() => { first.current?.focus({ preventScroll: true }); }, []);
  const [usage] = React.useState(counts);
  const frequent = [...new Set([...Object.keys(usage).sort((a, b) => usage[b] - usage[a]), ...defaults])].slice(0, defaults.length);
  function pick(value: string) {
    const next = counts();
    next[value] = (next[value] ?? 0) + 1;
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* Storage is optional. */ }
    onPick(value);
  }
  function grid(values: string[], frequent: boolean) {
    return <div className={frequent ? "grid grid-cols-7" : "grid grid-cols-9"}>{values.map((value, i) => <button key={value} type="button" ref={!frequent && i === 0 ? first : undefined} className="h-8 rounded-md text-xl hover:bg-dls-hover focus-visible:outline-ring" onClick={() => pick(value)}>{value}</button>)}</div>;
  }
  return <div role="dialog" aria-label={t("tasks.rich_text_emoji")} onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onCancel(); } }}
    style={{ maxHeight }} className={`absolute right-0 z-30 flex w-full max-w-[350px] flex-col overflow-y-auto overscroll-contain rounded-xl border border-dls-border bg-dls-surface shadow-xl ${above ? "bottom-full mb-1" : "top-full mt-1"}`}>
    <section className={maxHeight < 180 ? "shrink-0 p-2" : "min-h-0 overflow-y-auto overscroll-contain p-2"}><p className="mb-1 px-1 text-xs text-dls-secondary">{t("tasks.emoji_default")}</p>{grid(emojis, false)}</section>
    <section className="shrink-0 border-t border-dls-border bg-dls-hover p-2"><p className="mb-1 px-1 text-xs text-dls-secondary">{t("tasks.emoji_frequent")}</p>{grid(frequent, true)}</section>
  </div>;
}
