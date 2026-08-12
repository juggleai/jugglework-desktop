"use client"

import { SquareTerminalIcon } from "lucide-react"
import {
  CollapsibleTool,
  CollapsibleToolContent,
  CollapsibleToolStep,
  CollapsibleToolTrigger,
} from "@/components/tools/collapsible-tool"
import {
  redactSensitiveCommand,
  redactSensitiveReasoning,
} from "@/components/chat/reasoning-redaction"
import type { BashToolPart } from "@/lib/build-in-tools"

interface BashToolProps {
  part: BashToolPart
}

export function BashTool({ part }: BashToolProps) {
  const displayCommand = redactSensitiveCommand(part.input?.command)
  const displayDescription = redactSensitiveCommand(part.input?.description)
  const displayOutput = typeof part.output === "string"
    ? redactSensitiveReasoning(part.output)
    : part.output

  return (
    <CollapsibleTool>
      <CollapsibleToolStep className="flex flex-col gap-2">
        <CollapsibleToolTrigger leftIcon={<SquareTerminalIcon className="size-4" />}>
          <span className="flex gap-2">
            <span className="shrink-0">
              {displayDescription}
            </span>
            <span className="opacity-80 truncate grow">
              {displayCommand}
            </span>
          </span>
        </CollapsibleToolTrigger>
        <CollapsibleToolContent className="bg-muted rounded-lg p-2">
          <div className="flex flex-col gap-2 text-xs">
            <pre>$ {displayCommand}</pre>
            <pre className="opacity-80">{displayOutput}</pre>
          </div>
        </CollapsibleToolContent>
      </CollapsibleToolStep>
    </CollapsibleTool>
  )
}
