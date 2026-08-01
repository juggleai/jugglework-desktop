#!/usr/bin/env python3
"""Extract structured info from im-docs busserver *.md files.

Each doc has the layout:
  - front matter (title, sidebar_position)
  - ## 功能说明
  - ## 请求说明 (block quote: 鉴权, 类型, 限频, 地址, Content-Type)
  - ## 请求参数 (markdown table with 4 cols: 参数, 数据类型, 是否必填, 参数说明)
  - ## 请求示例 (js code block)
  - ## 响应示例 (json code block)
  - ## 响应码 (optional table)
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

SRC = Path("/Applications/work/im-docs/docs/client/busserver")
OUT = Path("/Applications/work/ai-skills-research/_sdk_extract/busserver_docs.json")
OUT.parent.mkdir(parents=True, exist_ok=True)


def strip_frontmatter(text: str) -> tuple[dict, str]:
    m = re.match(r"^---\n(.*?)\n---\n(.*)$", text, re.DOTALL)
    if not m:
        return {}, text
    fm = {}
    for ln in m.group(1).splitlines():
        if ':' in ln:
            k, v = ln.split(':', 1)
            fm[k.strip()] = v.strip()
    return fm, m.group(2)


def get_title(fm: dict, fallback: str) -> str:
    t = fm.get("title", "").strip().strip("'").strip('"')
    return t or fallback


def parse_section(text: str, marker: str) -> str:
    """Return content under a `### marker` heading, up to the next `### ` or end."""
    pat = "### " + re.escape(marker) + r"(?:\{[^}]*\})?"
    pat = pat + r"\n(.*?)(?=\n### |\Z)"
    m = re.search(pat, text, re.DOTALL)
    if not m:
        return ""
    return m.group(1).strip()



def parse_request(text: str) -> dict[str, str]:
    """Parse the `### 请求说明` block-quote list."""
    section = parse_section(text, "请求说明")
    out = {}
    for ln in section.splitlines():
        m = re.match(r"^>\s*\*\*(.+?)\*\*[：:]\s*(.+)$", ln.strip())
        if m:
            key = m.group(1).strip()
            val = m.group(2).strip()
            # strip markdown link wrappers in val
            val = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", val)
            # strip backticks
            val = val.strip("`").strip()
            out[key] = val
    return out


def parse_params(text: str) -> list[dict[str, str]]:
    section = parse_section(text, "请求参数")
    # Find first markdown table
    lines = section.splitlines()
    table_lines = []
    in_table = False
    for ln in lines:
        if ln.lstrip().startswith("|"):
            in_table = True
            table_lines.append(ln)
        elif in_table:
            break
    if not table_lines:
        return []
    # Parse rows
    rows = []
    for ln in table_lines:
        cells = [c.strip() for c in ln.strip().strip("|").split("|")]
        rows.append(cells)
    # Drop separator
    rows = [r for r in rows if not all(re.fullmatch(r":?-+:?", c) for c in r if c)]
    if len(rows) < 2:
        return []
    out = []
    for r in rows[1:]:
        # Pad
        while len(r) < 4:
            r.append("")
        out.append({
            "name": r[0],
            "type": r[1],
            "required": r[2],
            "desc": r[3],
        })
    return out


def parse_code_block(text: str, section_marker: str) -> str | None:
    section = parse_section(text, section_marker)
    m = re.search(r"```\s*(\w+)\s*\n(.*?)```", section, re.DOTALL)
    if m:
        return m.group(2).strip()
    return None


def parse_response_codes(text: str) -> list[dict[str, str]]:
    section = parse_section(text, "响应码")
    if not section:
        return []
    lines = section.splitlines()
    table_lines = [ln for ln in lines if ln.lstrip().startswith("|")]
    rows = []
    for ln in table_lines:
        cells = [c.strip() for c in ln.strip().strip("|").split("|")]
        rows.append(cells)
    rows = [r for r in rows if not all(re.fullmatch(r":?-+:?", c) for c in r if c)]
    if len(rows) < 2:
        return []
    out = []
    for r in rows[1:]:
        while len(r) < 2: r.append("")
        out.append({"code": r[0], "desc": r[1] if len(r) > 1 else ""})
    return out


def category_of(path: Path) -> str:
    rel = path.relative_to(SRC)
    parts = list(rel.parts[:-1])
    return "/".join(parts) if parts else "<root>"


def process(path: Path) -> dict[str, Any] | None:
    text = path.read_text(encoding="utf-8")
    fm, body = strip_frontmatter(text)
    title = get_title(fm, path.stem)
    if path.name in ("api.md", "status.md"):
        return None  # meta docs, skip
    request = parse_request(body)
    params = parse_params(body)
    req_example = parse_code_block(body, "请求示例")
    res_example = parse_code_block(body, "响应示例")
    res_codes = parse_response_codes(body)
    if not request:
        return None
    return {
        "file": str(path.relative_to(SRC)),
        "category": category_of(path),
        "title": title,
        "request": request,
        "params": params,
        "request_example": req_example,
        "response_example": res_example,
        "response_codes": res_codes,
    }


def main():
    files = sorted(SRC.rglob("*.md"))
    results = []
    for p in files:
        rec = process(p)
        if rec:
            results.append(rec)
    OUT.write_text(
        json.dumps(results, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"wrote {len(results)} entries -> {OUT}")


if __name__ == "__main__":
    main()
