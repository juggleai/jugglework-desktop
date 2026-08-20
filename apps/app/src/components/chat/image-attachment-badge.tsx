import * as React from "react"
import { X } from "lucide-react"

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

type ImageAttachmentBadgeProps = {
  /** 缩略图源地址 */
  src: string
  /** 图片描述文案，同时作为灯箱预览的可访问名称 */
  alt: string
  /** 移除回调；不传则不渲染移除按钮（如消息区只读展示） */
  onRemove?: () => void
  /** 追加到缩略图按钮上的样式，用于覆盖默认 10×10 尺寸（如输入栏的 14×14） */
  thumbnailClassName?: string
  /** 追加到最外层容器的样式 */
  className?: string
}

export function ImageAttachmentBadge({
  src,
  alt,
  onRemove,
  thumbnailClassName,
  className,
}: ImageAttachmentBadgeProps) {
  const [open, setOpen] = React.useState(false)

  return (
    <div className={cn("relative inline-flex shrink-0", className)}>
      <button
        type="button"
        className={cn(
          "h-10 w-10 overflow-hidden rounded-xl border border-border/70 bg-background/50 transition-opacity hover:opacity-90",
          thumbnailClassName,
        )}
        onClick={() => setOpen(true)}
        aria-label={`Expand ${alt}`}
        title={alt}
      >
        <img
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
        />
      </button>
      {onRemove ? (
        <button
          type="button"
          className="absolute right-1 top-1 inline-flex h-5 w-5 items-center justify-center rounded-full border border-white/20 bg-black/55 text-white shadow-sm transition-colors hover:bg-black/75"
          onClick={(event) => {
            event.stopPropagation()
            onRemove()
          }}
          aria-label={`Remove ${alt}`}
          title="Remove"
        >
          <X className="size-3" />
        </button>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        {/*
          TIPS: 灯箱紧贴图片（透明背景 + p-0），Dialog 自带的 ghost 关闭按钮是
          bg-transparent，浮在浅色图片上几乎不可见。这里关掉默认按钮，改用自绘
          DialogClose：深色半透明药丸 + 白色 X，放在图片边框内部右上角，
          任意亮暗图片下都清晰可辨，也不会超出图片边界。
        */}
        <DialogContent
          className="max-h-[90vh] w-auto max-w-[min(90vw,56rem)] border-none bg-transparent p-0 shadow-none sm:max-w-[min(90vw,56rem)]"
          showCloseButton={false}
        >
          <DialogTitle className="sr-only">{alt}</DialogTitle>
          <img
            src={src}
            alt={alt}
            className="max-h-[85vh] w-auto max-w-full rounded-xl object-contain"
          />
          <DialogClose
            className="absolute top-2 end-2 inline-flex size-8 items-center justify-center rounded-full bg-black/60 text-white shadow-lg ring-1 ring-white/20 backdrop-blur-sm transition-colors hover:bg-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
            aria-label="Close"
          >
            <X className="size-4" />
          </DialogClose>
        </DialogContent>
      </Dialog>
    </div>
  )
}
