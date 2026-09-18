import { describe, expect, test } from "bun:test"
import type { DynamicToolUIPart, UIMessage } from "ai"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { GeneratedImageResultCard } from "../src/components/chat/generated-image-result-card"
import {
  generatedImageResultFromToolPart,
  generatedImageResultsFromMessages,
} from "../src/components/chat/generated-image-result"
import { MessageListProvider } from "../src/components/chat/message-list-provider"
import { getArtifactsFromMessages } from "../src/lib/artifacts"

function imageToolPart(output: unknown, toolCallId = "image-call-1"): DynamicToolUIPart {
  return {
    type: "dynamic-tool",
    toolName: "jugglework_image_generate",
    toolCallId,
    state: "output-available",
    input: { prompt: "A quiet mountain lake" },
    output,
  }
}

function assistantMessage(...parts: DynamicToolUIPart[]): UIMessage {
  return {
    id: "assistant-image",
    role: "assistant",
    parts,
  }
}

describe("generated image transcript results", () => {
  test("parses the direct image tool JSON output", () => {
    const result = generatedImageResultFromToolPart(imageToolPart(JSON.stringify({
      ok: true,
      path: "artifacts/lake.png",
      result: {
        artifact: { path: "artifacts/lake.png", bytes: 2048, mimeType: "image/png" },
        model: { providerID: "volcengine", modelID: "seedream-4-5" },
        mode: "text-to-image",
      },
    })))

    expect(result).toEqual({
      toolCallId: "image-call-1",
      path: "artifacts/lake.png",
      name: "lake.png",
      bytes: 2048,
      mimeType: "image/png",
      model: { providerID: "volcengine", modelID: "seedream-4-5" },
      mode: "text-to-image",
    })
  })

  test("ignores failed, malformed, and unsafe image outputs", () => {
    expect(generatedImageResultFromToolPart(imageToolPart("not json"))).toBeNull()
    expect(generatedImageResultFromToolPart(imageToolPart({ ok: false }))).toBeNull()
    expect(generatedImageResultFromToolPart(imageToolPart({
      ok: true,
      result: { artifact: { path: "../outside.png", mimeType: "image/png" } },
    }))).toBeNull()
    expect(generatedImageResultFromToolPart(imageToolPart({
      ok: true,
      result: { artifact: { path: "artifacts/not-image.txt", mimeType: "text/plain" } },
    }))).toBeNull()
  })

  test("deduplicates previews and exposes the generated file as an artifact", () => {
    const output = JSON.stringify({
      ok: true,
      result: { artifact: { path: "artifacts/lake.webp", bytes: 4096, mimeType: "image/webp" } },
    })
    const message = assistantMessage(imageToolPart(output), imageToolPart(output, "image-call-2"))

    expect(generatedImageResultsFromMessages([message])).toHaveLength(1)
    expect(getArtifactsFromMessages([message], [], { includeTargetFallbacks: false })).toMatchObject([{
      path: "artifacts/lake.webp",
      name: "lake.webp",
      type: "image",
    }])
  })

  test("renders persistent preview, download, and save-as affordances", () => {
    const noop = () => {}
    const result = generatedImageResultFromToolPart(imageToolPart(JSON.stringify({
      ok: true,
      result: { artifact: { path: "artifacts/lake.png", bytes: 2048, mimeType: "image/png" } },
    })))
    expect(result).not.toBeNull()

    const html = renderToStaticMarkup(React.createElement(
      MessageListProvider,
      {
        workspaceId: "workspace-a",
        sessionId: "session-a",
        showThinking: false,
        developerMode: false,
        displaySuggestions: false,
        providerConnectedCount: 1,
        dispatchAction: noop,
        setPrompt: noop,
        onRevertToUserMessage: noop,
        onForkAtMessage: noop,
        onEditUserMessage: noop,
        onMcpReconnect: async () => "connected" as const,
        onMcpReopenAuthorization: async () => {},
        onMcpRetry: noop,
        children: React.createElement(GeneratedImageResultCard, { result: result! }),
      },
    ))

    expect(html).toContain('data-testid="generated-image-result"')
    expect(html).toContain('data-generated-image-path="artifacts/lake.png"')
    expect(html).toContain("Download")
    expect(html).toContain("Save as")
  })
})
