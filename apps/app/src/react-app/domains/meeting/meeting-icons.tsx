import type { SVGProps } from "react";
import {
  Monitor, AppWindow, RefreshCw, ArrowRight, CalendarDays, Check, ChevronLeft, ChevronRight, Clock3, Copy,
  Download, LayoutGrid, Maximize2, MessageSquare, Mic, MicOff,
  ScreenShare, ScreenShareOff, Search, Settings, UsersRound, Video, VideoOff, X, Plus,
} from "lucide-react";

function HangupIcon(props: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" {...props}>
    <path d="M4 15v-3q8-8 16 0v3l-4-1v-3 M4 15l4-1v-3" />
  </svg>;
}

const icons = {
  chevronLeft: ChevronLeft, chevronRight: ChevronRight, search: Search, clock: Clock3,
  download: Download, grid: LayoutGrid, expand: Maximize2, hangup: HangupIcon,
  video: Video, calendar: CalendarDays, plus: Plus, close: X, mic: Mic,
  screen: ScreenShare, chat: MessageSquare, users: UsersRound, arrow: ArrowRight,
  settings: Settings, copy: Copy, check: Check, monitor: Monitor, window: AppWindow, refresh: RefreshCw,
};
export function MeetingIcon({ name = "video", off, style, ...props }:
  SVGProps<SVGSVGElement> & { name?: keyof typeof icons; off?: boolean }) {
  const Icon = off && name === "mic" ? MicOff
    : off && name === "video" ? VideoOff
    : off && name === "screen" ? ScreenShareOff : icons[name];
  return <Icon width={20} height={20} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true" {...props} style={style} />;
}
