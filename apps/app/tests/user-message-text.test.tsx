import * as React from "react"
import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { UserMessageText } from "../src/components/chat/user-message-text"

const bubble = (text: string) => renderToStaticMarkup(<UserMessageText text={text} renderText={value => value} />)

test("sent prompts render link labels, paragraphs, emphasis and headings", () => {
  const html = bubble("[你好](https://www.baidu.com/)\n这个连接里面是什么内容\n# 小结\n测*试* **测**试")
  expect(html).toContain('href="https://www.baidu.com/"')
  expect(html).toContain(">你好</a>")
  expect(html).toContain("这个连接里面是什么内容</div>")
  expect(html).toContain(">小结</h1>")
  expect(html).toContain(">试</em>")
  expect(html).toContain(">测</strong>")
  expect(html).not.toContain("[你好]")
})

test("renders composer lists including a final empty bullet in trimmed history", () => {
  const html = bubble("编号：\n- 第一项\n- 第二项\n-\n\n  3. 第三项\n  4. 第四项")
  expect(html).toContain("<ul ")
  expect(html).toContain('start="3"')
  expect(html.match(/<li /g)).toHaveLength(5)
  expect(html).not.toContain("3. 第三项")
})

test("keeps chips intact for the message renderer and forwards the search query", () => {
  const html = renderToStaticMarkup(<UserMessageText text={"- [skill **demo**] 搜索"} highlightQuery="搜索"
    renderText={(value, query) => value === "[skill **demo**]" ? <button>技能</button> : value.includes(query!) ? <mark>{value}</mark> : value} />)
  expect(html).toContain("<button>技能</button><mark> 搜索</mark>")
})

test("keeps pasted HTML literal and rejects non-web script links", () => {
  const html = bubble('<b>literal</b> **bold** [link](javascript:example)')
  expect(html).toContain("&lt;b&gt;literal&lt;/b&gt;")
  expect(html).not.toContain("<a ")
})
