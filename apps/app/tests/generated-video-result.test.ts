import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "bun:test"
import type { DynamicToolUIPart, UIMessage } from "ai"

import {
  generatedVideoJobFromToolPart,
  generatedVideoJobsForMessageScope,
  generatedVideoJobsFromMessages,
  isGeneratedVideoJobRecent,
} from "../src/components/chat/generated-video-result"
import { getArtifactsFromMessages } from "../src/lib/artifacts"

const cardPath = fileURLToPath(new URL("../src/components/chat/generated-video-result-card.tsx", import.meta.url))

function videoToolPart(output: unknown, toolName = "jugglework_video_generate", toolCallId = "video-call-1"): DynamicToolUIPart {
  return {
    type: "dynamic-tool",
    toolName,
    toolCallId,
    state: "output-available",
    input: { prompt: "A puppy chasing a frisbee" },
    output,
  }
}

function assistantMessage(...parts: DynamicToolUIPart[]): UIMessage {
  return { id: `assistant-video-${parts[0]?.toolCallId ?? "empty"}`, role: "assistant", parts }
}

describe("generated video transcript results", () => {
  test("parses completed direct video tool output", () => {
    const result = generatedVideoJobFromToolPart(videoToolPart(JSON.stringify({
      ok: true,
      result: {
        job: {
          id: "job-1",
          status: "completed",
          revision: 4,
          model: { providerID: "volcengine", modelID: "seedance-2" },
          artifact: { path: "artifacts/puppy.mp4", mimeType: "video/mp4", bytes: 4096 },
        },
      },
    })))

    expect(result).toMatchObject({
      id: "job-1",
      status: "completed",
      revision: 4,
      model: { providerID: "volcengine", modelID: "seedance-2" },
      artifact: { path: "artifacts/puppy.mp4", name: "puppy.mp4", mimeType: "video/mp4", bytes: 4096 },
    })
  })

  test("accepts staged job updates, keeps the newest revision, and exposes the artifact", () => {
    const submitted = videoToolPart({ ok: true, result: { job: { id: "job-1", status: "submitted", revision: 1 } } })
    const completed = videoToolPart({
      ok: true,
      result: { job: { id: "job-1", status: "completed", revision: 3, artifact: { path: "artifacts/puppy.webm", mimeType: "video/webm", bytes: 8192 } } },
    }, "jugglework_video_job_get", "video-call-2")
    const message = assistantMessage(submitted, completed)

    expect(generatedVideoJobsFromMessages([message])).toMatchObject([{ status: "completed", revision: 3 }])
    expect(getArtifactsFromMessages([message], [], { includeTargetFallbacks: false })).toMatchObject([{
      path: "artifacts/puppy.webm",
      type: "video",
    }])
  })

  test("renders a repeated job only beside its latest transcript update", () => {
    const submittedMessage = assistantMessage(videoToolPart({
      ok: true,
      result: { job: { id: "job-1", status: "submitted", revision: 1 } },
    }))
    const completedMessage = assistantMessage(videoToolPart({
      ok: true,
      result: { job: { id: "job-1", status: "completed", revision: 3 } },
    }, "jugglework_video_job_get", "video-call-2"))
    const allMessages = [submittedMessage, completedMessage]

    expect(generatedVideoJobsForMessageScope([submittedMessage], allMessages)).toEqual([])
    expect(generatedVideoJobsForMessageScope([completedMessage], allMessages)).toMatchObject([{
      id: "job-1",
      status: "completed",
      toolCallId: "video-call-2",
    }])
  })

  test("rejects unsafe or non-video artifacts", () => {
    expect(generatedVideoJobFromToolPart(videoToolPart("not json"))).toBeNull()
    expect(generatedVideoJobFromToolPart(videoToolPart({ ok: false }))).toBeNull()
    const unsafe = generatedVideoJobFromToolPart(videoToolPart({
      ok: true,
      result: { job: { id: "job-1", status: "completed", artifact: { path: "../outside.mp4", mimeType: "video/mp4" } } },
    }))
    expect(unsafe?.artifact).toBeUndefined()
  })

  test("does not announce stale terminal jobs when opening old transcripts", () => {
    const now = 2_000_000
    const base = { toolCallId: "call", id: "job", status: "completed" }
    expect(isGeneratedVideoJobRecent({ ...base, updatedAt: now - 60_000 }, now)).toBe(true)
    expect(isGeneratedVideoJobRecent({ ...base, updatedAt: now - 11 * 60_000 }, now)).toBe(false)
  })

  test("provides live polling, playback, expanded preview, download, and completion notifications", () => {
    const source = readFileSync(cardPath, "utf8")
    expect(source).toContain('action: "video_job_get"')
    expect(source).toContain("<video")
    expect(source).toContain("setOpen(true)")
    expect(source).toContain("downloadObjectUrl")
    expect(source).toContain("notifyEvent")
    expect(source).toContain("notifyDesktopEvent")
    expect(source).toContain("toast.success")
  })
})
