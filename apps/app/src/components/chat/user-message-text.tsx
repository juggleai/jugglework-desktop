import { Fragment, memo, useMemo, type ReactNode } from "react"
import { $createParagraphNode, $createTextNode, $getRoot, $isElementNode, $isTextNode, createEditor, type LexicalNode } from "lexical"
import { $isListItemNode, $isListNode, ListItemNode, ListNode } from "@lexical/list"
import { $isHeadingNode, HeadingNode } from "@lexical/rich-text"
import { $isLinkNode, LinkNode } from "@lexical/link"
import { $restoreRichDraft, composerRichTheme as theme } from "@/react-app/domains/session/surface/composer/markdown-editing"
import { CAPABILITY_INSTRUCTION_RE } from "@/react-app/domains/session/surface/composer/capability-tags"

// Use the same draft reader as the editable composer. Keep the original message
// available for copy/edit and mount only static elements in the transcript.
function readFormattedMessage(text: string) {
  if (!/[*\x60]|\]\(|^[ \t]*(?:#{1,3}\s|[-+]\s|\d+[.)、．）])/m.test(text)) return null
  const editor = createEditor({ nodes: [HeadingNode, ListNode, ListItemNode, LinkNode] })
  editor.update(() => {
    const root = $getRoot()
    for (const line of text.split(/\r?\n/)) {
      const paragraph = $createParagraphNode()
      root.append(paragraph)
      for (const part of line.split(/(\[cloud-doc [^\]\s]+\])/)) {
        if (part.startsWith("[cloud-doc ")) {
          paragraph.append($createTextNode(part).setMode("token"))
          continue
        }
        // The capturing group contains the whole capability instruction.
        part.split(CAPABILITY_INSTRUCTION_RE).forEach((piece, index) => {
          if (piece) paragraph.append($createTextNode(piece).setMode(index % 2 ? "token" : "normal"))
        })
      }
    }
    $restoreRichDraft()
  }, { discrete: true })
  return editor.getEditorState()
}

type RenderText = (text: string, highlightQuery: string | undefined) => ReactNode

function renderNode(node: LexicalNode, renderText: RenderText, query: string | undefined): ReactNode {
  const key = node.getKey()
  if ($isTextNode(node)) {
    let label = renderText(node.getTextContent(), query)
    if (node.hasFormat("code")) label = <code className={theme.text.code}>{label}</code>
    if (node.hasFormat("italic")) label = <em className={theme.text.italic}>{label}</em>
    if (node.hasFormat("bold")) label = <strong className={theme.text.bold}>{label}</strong>
    return <Fragment key={key}>{label}</Fragment>
  }
  if (!$isElementNode(node)) return null
  const children = node.getChildren().map(child => renderNode(child, renderText, query))
  if ($isLinkNode(node)) return <a key={key} href={node.getURL()} className={theme.link} target="_blank" rel="noopener noreferrer">{children}</a>
  if ($isListItemNode(node)) return <li key={key} className={theme.list.listitem}>{children}</li>
  if ($isListNode(node)) return node.getListType() === "number"
    ? <ol key={key} className={theme.list.ol} start={node.getStart()}>{children}</ol>
    : <ul key={key} className={theme.list.ul}>{children}</ul>
  if ($isHeadingNode(node)) {
    const Tag = node.getTag() as keyof typeof theme.heading
    return <Tag key={key} className={theme.heading[Tag]}>{children}</Tag>
  }
  return <div key={key} className="min-h-[1lh]">{children}</div>
}

export const UserMessageText = memo(function UserMessageText({ text, highlightQuery, renderText }: {
  text: string; highlightQuery?: string; renderText: RenderText
}) {
  const state = useMemo(() => readFormattedMessage(text), [text])
  if (!state) return <span className="whitespace-pre-wrap">{renderText(text, highlightQuery)}</span>
  return <div className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
    {state.read(() => $getRoot().getChildren().map(node => renderNode(node, renderText, highlightQuery)))}
  </div>
})
