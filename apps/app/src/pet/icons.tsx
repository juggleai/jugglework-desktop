import type { SVGProps } from "react";

/** 宠物工具条的圆角编辑图标，与参考图的开口方框、斜向笔尖保持一致。 */
export function PetComposeIcon(props: SVGProps<SVGSVGElement>) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    <path d="M11 4H6a3 3 0 0 0-3 3v11a3 3 0 0 0 3 3h11a3 3 0 0 0 3-3v-5" />
    <path d="m10 15 1-4L18.2 3.8a2.1 2.1 0 0 1 3 3L14 14Z" />
  </svg>;
}

/** 五条圆头声波线；保持参考图的节奏和视觉宽度。 */
export function PetVoiceIcon(props: SVGProps<SVGSVGElement>) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" {...props}>
    <path d="M4 10v4m4-8v12m4-15v18m4-14v10m4-7v4" />
  </svg>;
}
