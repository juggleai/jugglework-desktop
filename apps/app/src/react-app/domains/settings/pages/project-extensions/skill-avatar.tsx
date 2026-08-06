/** @jsxImportSource react */
import { cn } from "@/lib/utils";

// TIPS: SkillHub 列表项与本地技能都没有图标字段，用「首字母 + 名称哈希色」生成
// 稳定的占位头像，保证同名技能颜色一致、视觉上可区分。
const AVATAR_PALETTE = [
  "bg-blue-3 text-blue-11",
  "bg-green-3 text-green-11",
  "bg-amber-3 text-amber-11",
  "bg-purple-3 text-purple-11",
  "bg-pink-3 text-pink-11",
  "bg-cyan-3 text-cyan-11",
  "bg-orange-3 text-orange-11",
  "bg-indigo-3 text-indigo-11",
];

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function initialOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  // 取首个「字母/数字/CJK」字符作为头像文字。
  const match = trimmed.match(/[\p{L}\p{N}]/u);
  return (match ? match[0] : trimmed[0]).toUpperCase();
}

/**
 * 技能占位头像
 * @param name 技能名称，用于生成首字母与配色
 * @param sizeClass 尺寸类名（默认 size-8）
 */
export function SkillAvatar({ name, sizeClass = "size-8", className }: {
  name: string;
  sizeClass?: string;
  className?: string;
}) {
  const palette = AVATAR_PALETTE[hashString(name) % AVATAR_PALETTE.length];
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg text-sm font-semibold",
        sizeClass,
        palette,
        className,
      )}
      aria-hidden
    >
      {initialOf(name)}
    </span>
  );
}
