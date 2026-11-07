"""Notion-flavored Markdown → 清洗后的正文 HTML 片段（无第三方依赖）。

只做「文章正文」相关的事：
  parse_markdown()  把 v2 markdown（CommonMark + Notion XML 块标签）解析成 Block 树；
  clean_blocks()    按 notion-audit R2/R3/R17/R19/R20 与标题层级规则清洗；
  attach_captions() 图片「图注：」/「图：」、mermaid 前置「图N：」图题归一；
  render_article()  输出契约 v1 的 <article class="kb-art"> 片段。

调用方（sync.py）负责提供图片 media dict 和 mermaid svg 字符串。
"""
from __future__ import annotations

import html as _html
import re
from dataclasses import dataclass, field
from typing import Any

# ---------------------------------------------------------------- block model

CONTAINER_TAGS = {
    "callout", "quote", "toggle", "columns", "column", "tabs", "tab",
    "ul", "ol", "synced-block", "meeting-notes", "p", "h1", "h2", "h3", "h4",
}
TEXT_TAGS = {
    "page", "folder", "database", "bookmark", "embed", "link-preview",
    "pdf", "file", "video", "audio", "image", "equation",
    "external_object_instance", "unknown", "table-of-contents", "custom-block",
    "table", "tr",
}
ALL_BLOCK_TAGS = CONTAINER_TAGS | TEXT_TAGS

_HEADING_RE = re.compile(r"^(#{1,6})[ \t]+(.*?)[ \t]*$")
_DIVIDER_RE = re.compile(r"^(?:-{3,}|\*{3,}|_{3,})[ \t]*$")
_LIST_RE = re.compile(r"^(?P<indent>[ \t]*)(?P<marker>[-*+]|\d+[.)])[ \t]+(?P<rest>.*)$")
_TABLE_SEP_RE = re.compile(r"^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)+\|?[ \t]*$")
_IMAGE_MD_RE = re.compile(r"^!\[(?P<alt>[^\]]*)\]\((?P<url>[^)\s]+)(?:\s+\"[^\"]*\")?\)[ \t]*$")
_TAG_AT_LINE_RE = re.compile(r"^<([A-Za-z][A-Za-z0-9-]*)(?:\s[^<>]*?)?/?>", re.S)
_MERMAID_HINT_RE = re.compile(
    r"^(?:flowchart|graph|sequenceDiagram|stateDiagram(?:-v2)?|classDiagram|erDiagram|"
    r"gantt|journey|mindmap|timeline|quadrantChart|xychart(?:-beta)?|block-beta|"
    r"sankey(?:-beta)?|packet(?:-beta)?|pie|requirementDiagram|gitGraph|C4Context|"
    r"C4Container|C4Component)\b"
)
_CAPTION_RE = re.compile(r"^(图注|图)\s*[：:]\s*")
# CommonMark：反斜杠可转义 ASCII 标点；代码/公式/mermaid 内部不做还原
_ESCAPE_RE = re.compile(r"\\([\\!\"#$%&'()*+,\-./:;<=>?@\[\]^_`{|}~])")
_MM_CAPTION_RE = re.compile(r"^图\s*\d+\s*[：:]")

# 中文/英文可见字符，用于 words 近似统计
_WORD_RE = re.compile(r"[\u4e00-\u9fff\u3400-\u4dbf]|[A-Za-z0-9]+")


@dataclass
class Block:
    type: str
    text: str = ""                 # 段落/标题的 inline 源码
    level: int = 0                 # 标题级别
    lang: str = ""                 # 代码语言
    code: str = ""                 # 代码原文 / mermaid 源码
    ordered: bool = False
    items: list[dict] = field(default_factory=list)   # [{text, checked, children}]
    children: list["Block"] = field(default_factory=list)
    rows: list[list[str]] = field(default_factory=list)  # 表格单元格（inline 源码）
    header: bool = False
    url: str = ""
    alt: str = ""
    caption: str = ""
    icon: str = ""
    title: str = ""
    media: dict | None = None      # {sha, ext, w, h}
    svg: str = ""
    error: str = ""
    meta: dict = field(default_factory=dict)


# ---------------------------------------------------------------- inline html

_ESC = {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}


def esc(text: str) -> str:
    return "".join(_ESC.get(ch, ch) for ch in text)


def _norm_page_id(value: str) -> str:
    m = re.search(r"([0-9a-fA-F]{8})-?([0-9a-fA-F]{4})-?([0-9a-fA-F]{4})-?([0-9a-fA-F]{4})-?([0-9a-fA-F]{12})", value)
    if m:
        return "".join(m.groups()).lower()
    m = re.search(r"\b([0-9a-fA-F]{32})\b", value)
    return m.group(1).lower() if m else ""


_NOTION_HOSTS = ("notion.so", "notion.site", "notion.com", "app.notion.com")


def _is_notion_url(url: str) -> bool:
    low = url.lower()
    return any(h in low for h in _NOTION_HOSTS) or low.startswith("notion-file-block:")


class InlineRenderer:
    """把一行 inline markdown/Notion 标签渲染成允许的 HTML。"""

    def __init__(self, linkmap: dict[str, dict] | None = None):
        self.linkmap = linkmap or {}
        self._ph: list[str] = []

    # -- 链接 ---------------------------------------------------------------
    def link(self, url: str, label_html: str) -> str:
        raw = _html.unescape(url.strip())
        if raw.startswith("<") and raw.endswith(">"):
            raw = raw[1:-1]
        if not raw:
            return label_html
        pid = _norm_page_id(raw)
        target = self.linkmap.get(pid) if pid else None
        if target:
            href = f"/kb/a/{target['course']}/{target['article']}.html"
            attr = f' data-kb-article="{esc(target["article"])}"'
            return f'<a href="{esc(href)}"{attr}>{label_html}</a>'
        if _is_notion_url(raw):
            return label_html or ""
        if raw.startswith("mailto:"):
            return f'<a href="{esc(raw)}" data-external="1">{label_html or esc(raw)}</a>'
        if raw.startswith("#"):
            return f'<a href="{esc(raw)}">{label_html}</a>'
        if not re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", raw):
            return label_html or esc(raw)
        return f'<a href="{esc(raw)}" data-external="1">{label_html or esc(raw)}</a>'

    def _hold(self, html_fragment: str) -> str:
        self._ph.append(html_fragment)
        return f"\x00K{len(self._ph) - 1}\x00"

    def _restore(self, text: str) -> str:
        def repl(m: re.Match) -> str:
            i = int(m.group(1))
            return self._ph[i] if 0 <= i < len(self._ph) else ""
        # fragment 里可能还嵌着外层占位符（如 mention label 里的行内代码），循环还原
        for _ in range(10):
            if "\x00K" not in text:
                break
            new = re.sub(r"\x00K(\d+)\x00", repl, text)
            if new == text:
                break
            text = new
        return text

    # -- 主流程 -------------------------------------------------------------
    def render(self, text: str, *, allow_links: bool = True) -> str:
        if not text:
            return ""
        s = text
        # 0. 行内代码最先抽出（代码里的反斜杠保持原样），再做 CommonMark 反斜杠转义；
        #    顺序必须在 mention/style/link/公式之前，否则 \<b>、\*、\$ 会被当成语法。
        s = re.sub(r"(`+)(.+?)\1", lambda m: self._hold(f"<code>{esc(m.group(2))}</code>"), s, flags=re.S)
        s = _ESCAPE_RE.sub(lambda m: self._hold(esc(m.group(1))), s)
        # 1. mention（成对 / 自闭合）
        def mention_pair(m: re.Match) -> str:
            attrs, label = m.group(1) or "", m.group(2)
            url = _attr(attrs, "url")
            inner = self._render_simple(label) if label else ""
            if not allow_links:
                return self._hold(inner)
            return self._hold(self.link(url, inner))

        s = re.sub(r"<mention\b([^<>]*?)>(.*?)</mention>", mention_pair, s, flags=re.S)

        def mention_self(m: re.Match) -> str:
            url = _attr(m.group(1), "url")
            pid = _norm_page_id(url)
            target = self.linkmap.get(pid) if pid else None
            if target:
                label = esc(target.get("title") or target.get("article") or "")
                return self._hold(self.link(url, label))
            return self._hold("〔未收录内容〕")

        s = re.sub(r"<mention\b([^<>]*?)/>", mention_self, s)
        # 2. 行内 date / page / custom-block / link-preview
        s = re.sub(r"<date\b([^<>]*?)/>", lambda m: self._hold(esc(_date_text(m.group(1)))), s)
        s = re.sub(r"<page\b([^<>]*?)>(.*?)</page>",
                   lambda m: self._hold(self.link(_attr(m.group(1), "url"), self._render_simple(m.group(2)))),
                   s, flags=re.S)
        s = re.sub(r"<link-preview\b[^<>]*/>", "", s)
        s = re.sub(r"<custom-block\b[^<>]*/>", "", s)
        # 3. 行内样式标签：b/i/s/u/mark/sub/sup/span（span 去色只留内容）
        s = re.sub(r"<span\b[^<>]*?>(.*?)</span>", lambda m: self._render_simple(m.group(1)), s, flags=re.S)
        pairs = {"b": "strong", "i": "em", "s": "s", "u": "u", "mark": "", "sub": "sub", "sup": "sup"}
        def style_pair(m: re.Match) -> str:
            tag = m.group(1).lower()
            inner = self._render_simple(m.group(2))
            mapped = pairs.get(tag, "")
            return self._hold(f"<{mapped}>{inner}</{mapped}>" if mapped else inner)
        s = re.sub(r"<(b|i|s|u|mark|sub|sup)\b[^<>]*?>(.*?)</\1>", style_pair, s, flags=re.S | re.I)
        s = re.sub(r"<br\s*/?>", lambda m: self._hold("<br>"), s, flags=re.I)
        # 4. 行内公式（转义已在最前面处理，\$ 不会被当成公式定界符）
        s = re.sub(r"\$([^$\n]+)\$", lambda m: self._hold(f"<code>{esc(m.group(1))}</code>"), s)
        # 5. 图片：正文内出现时只保留 alt/丢弃
        s = re.sub(r"!\[([^\]]*)\]\([^)]*\)", lambda m: esc(m.group(1)), s)
        # 6. 链接
        def md_link(m: re.Match) -> str:
            label, url = m.group(1), m.group(2)
            inner = self._render_simple(label)
            if not allow_links:
                return self._hold(inner)
            return self._hold(self.link(url, inner))
        s = re.sub(r"\[([^\]]*)\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)", md_link, s)
        s = re.sub(r"\[\^([^\]]+)\]", lambda m: self._hold(self.link(m.group(1), esc(m.group(1)))), s)
        s = re.sub(r"<((?:https?|mailto):[^<>\s]+)>", lambda m: self._hold(self.link(m.group(1), esc(m.group(1)))), s)
        # 7. 其余文本转义
        s = esc(s)
        # 8. 强调（在转义后的文本上做；占位符里没有 * _）
        s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s, flags=re.S)
        s = re.sub(r"__(.+?)__", r"<strong>\1</strong>", s, flags=re.S)
        s = re.sub(r"~~(.+?)~~", r"<s>\1</s>", s, flags=re.S)
        s = re.sub(r"(?<![\w*])\*([^*\n]+)\*(?![\w*])", r"<em>\1</em>", s)
        s = re.sub(r"(?<![\w_])_([^_\n]+)_(?![\w_])", r"<em>\1</em>", s)
        # 9. 段落内换行 → <br>
        s = s.replace("\n", "<br>")
        return self._restore(s)

    def _render_simple(self, text: str) -> str:
        """标签内部文字：允许行内样式、不要链接（避免嵌套 <a>）。"""
        return self.render(text, allow_links=False)


def _attr(attr_text: str, name: str) -> str:
    m = re.search(r'%s\s*=\s*"([^"]*)"' % re.escape(name), attr_text)
    if not m:
        m = re.search(r"%s\s*=\s*'([^']*)'" % re.escape(name), attr_text)
    return _html.unescape(m.group(1)) if m else ""


def _date_text(attrs: str) -> str:
    start = _attr(attrs, "start")
    start_time = _attr(attrs, "start-time")
    end = _attr(attrs, "end")
    if start and end and end != start:
        return f"{start} – {end}"
    if start and start_time:
        return f"{start} {start_time}"
    return start or ""


# ---------------------------------------------------------------- parser

def _scan_container_text(text: str, pos: int, tag: str) -> tuple[str, int] | None:
    """text[pos:] 以 <tag ...> 开头时返回 (inner, 结束位置)；自闭合返回 ("", pos)。"""
    head = re.match(r"<%s\b((?:\s+[^<>]*?)?)(/?)>" % re.escape(tag), text[pos:], re.S)
    if not head:
        return None
    start = pos + head.end()
    if head.group(2) == "/":
        return "", start
    depth = 1
    pat = re.compile(r"<%s\b[^<>]*?/?>|</%s\s*>" % (re.escape(tag), re.escape(tag)), re.S)
    p = start
    while True:
        m = pat.search(text, p)
        if not m:
            return None
        tok = m.group(0)
        if tok.startswith("</"):
            depth -= 1
        elif not tok.endswith("/>"):
            depth += 1
        p = m.end()
        if depth == 0:
            return text[start:m.start()], p


_BROKEN_FENCE_RE = re.compile(
    # 形如 \`\`\`mermaid<br />…<br />\`\`\`（每个反引号前有一个反斜杠）
    r"(?:\\`){3,}\s*([A-Za-z0-9+#.-]*)\s*<br\s*/?>(.*?)(?:\\`){3,}", re.S
)


_DISPLAY_MATH_RE = re.compile(r"\$\$(.+?)\$\$", re.S)


def repair_display_math(text: str) -> str:
    r"""Notion v2 的 display math 用 $$...$$ 包一段 LaTeX。

    App 没有 KaTeX，统一降级成代码块原样展示；否则 LaTeX 里的 \\、\[ 会被当成 Markdown 转义/硬换行。
    """
    def repl(m: re.Match) -> str:
        body = m.group(1).strip()
        return f"\n```math\n{body}\n```\n"
    return _DISPLAY_MATH_RE.sub(repl, text)


def repair_broken_fences(text: str) -> str:
    """Notion 历史脏数据：转义的 ```mermaid 被粘成一行、行间用 <br />。

    还原成真正的 fenced code block，让 mermaid 渲染器处理（失败则保留源码 fallback）。
    """
    def repl(m: re.Match) -> str:
        lang = (m.group(1) or "").strip()
        body = re.sub(r"<br\s*/?>", "\n", m.group(2), flags=re.I)
        body = _ESCAPE_RE.sub(r"\1", body).strip()
        return f"\n```{lang}\n{body}\n```\n"

    return _BROKEN_FENCE_RE.sub(repl, text)


class MarkdownParser:
    def __init__(self, text: str):
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        self.s = repair_broken_fences(repair_display_math(text))
        if not self.s.endswith("\n"):
            self.s += "\n"
        self.n = len(self.s)
        self.pos = 0

    # -- 基础工具 -----------------------------------------------------------
    def eof(self) -> bool:
        return self.pos >= self.n

    def _line_end(self, pos: int | None = None) -> int:
        p = self.pos if pos is None else pos
        e = self.s.find("\n", p)
        return self.n if e < 0 else e

    def line(self, pos: int | None = None) -> str:
        p = self.pos if pos is None else pos
        return self.s[p:self._line_end(p)]

    def next_line(self) -> str:
        e = self._line_end()
        if e >= self.n - 1:
            return ""
        return self.s[e + 1:self._line_end(e + 1)]

    def advance(self, count: int = 1) -> None:
        for _ in range(count):
            e = self._line_end()
            self.pos = e + 1

    def skip_blank(self) -> None:
        while not self.eof() and not self.line().strip():
            self.advance()

    # -- 入口 ---------------------------------------------------------------
    def parse(self) -> list[Block]:
        blocks: list[Block] = []
        while True:
            self.skip_blank()
            if self.eof():
                break
            before = self.pos
            block = self._parse_one()
            if block is None:
                # 兜底：整行作为段落，避免死循环
                text = self.line().strip()
                self.advance()
                if text:
                    blocks.append(Block(type="p", text=text))
                continue
            if isinstance(block, list):
                blocks.extend(block)
            else:
                blocks.append(block)
            if self.pos == before:
                self.advance()
        return blocks

    def _parse_one(self) -> Block | list[Block] | None:
        line = self.line()
        stripped = line.strip()
        if not stripped:
            return None

        # 1) 代码围栏
        m = re.match(r"^\s*(`{3,})(.*)$", line)
        if m:
            return self._parse_fence(len(m.group(1)), m.group(2).strip())

        # 2) Notion 块标签
        if stripped.startswith("<"):
            tag_m = _TAG_AT_LINE_RE.match(stripped)
            if tag_m:
                tag = tag_m.group(1).lower()
                if tag in ALL_BLOCK_TAGS:
                    return self._parse_tag_block(tag)

        # 3) 标题
        m = _HEADING_RE.match(stripped)
        if m:
            self.advance()
            return Block(type="h", level=len(m.group(1)), text=m.group(2).strip())

        # 4) 分割线
        if _DIVIDER_RE.match(stripped):
            self.advance()
            return Block(type="hr")

        # 5) 引用
        if stripped.startswith(">"):
            return self._parse_quote()

        # 6) 列表
        if _LIST_RE.match(line):
            return self._parse_list()

        # 7) 图片（markdown 形式，独占一行）
        m = _IMAGE_MD_RE.match(stripped)
        if m:
            self.advance()
            return Block(type="image", url=m.group("url"), alt=m.group("alt"))

        # 8) 管道表格
        if "|" in stripped and _TABLE_SEP_RE.match(self.next_line()):
            return self._parse_pipe_table()

        # 9) 段落
        return self._parse_paragraph()

    # -- 各类块 -------------------------------------------------------------
    def _parse_fence(self, fence_len: int, info: str) -> Block:
        self.advance()
        lines: list[str] = []
        close_re = re.compile(r"^\s*`{%d,}\s*$" % fence_len)
        while not self.eof():
            ln = self.line()
            if close_re.match(ln):
                self.advance()
                break
            lines.append(ln)
            self.advance()
        code = "\n".join(lines)
        lang = (info.split()[0].lower() if info else "")
        lang = re.sub(r"[^a-z0-9+#.-]", "", lang)
        return Block(type="code", lang=lang, code=code)

    def _scan_container(self, pos: int, tag: str) -> tuple[str, int] | None:
        head = re.match(r"<%s\b((?:\s+[^<>]*?)?)(/?)>" % re.escape(tag), self.s[pos:], re.S)
        if not head:
            return None
        start = pos + head.end()
        if head.group(2) == "/":
            return "", start
        depth = 1
        pat = re.compile(
            r"<%s\b[^<>]*?/?>|</%s\s*>" % (re.escape(tag), re.escape(tag)), re.S
        )
        p = start
        while True:
            m = pat.search(self.s, p)
            if not m:
                return None
            tok = m.group(0)
            if tok.startswith("</"):
                depth -= 1
            elif not tok.endswith("/>"):
                depth += 1
            p = m.end()
            if depth == 0:
                return self.s[start:m.start()], m.end()

    def _parse_tag_block(self, tag: str) -> Block | list[Block] | None:
        start = self.pos
        scanned = self._scan_container(start, tag)
        if scanned is None:
            # 不成对：把当前行当段落处理，避免吞掉后面内容
            self.advance()
            return Block(type="p", text=self.line() if False else self.s[start:self._line_end(start)].strip())
        inner, end = scanned
        attrs = ""
        head = re.match(r"<%s\b((?:\s+[^<>]*?)?)/?>" % re.escape(tag), self.s[start:], re.S)
        if head:
            attrs = head.group(1) or ""
        self.pos = end
        if end < self.n and self.s[end] == "\n":
            self.pos += 1

        if tag == "image":
            url = _attr(attrs, "source") or _attr(attrs, "src") or _attr(attrs, "url")
            caption = _strip_emph(inner.strip())
            alt = _attr(attrs, "alt")
            return Block(type="image", url=url, alt=alt or caption, caption=caption)
        if tag == "table-of-contents":
            return Block(type="toc")
        if tag in ("h1", "h2", "h3", "h4"):
            return Block(type="h", level=int(tag[1]), text=inner.strip())
        if tag == "p":
            text = inner.strip()
            if not text:
                return None
            blocks = self.parse_sub(text)
            return blocks if blocks else Block(type="p", text=re.sub(r"\n+", "\n", text))
        if tag == "table":
            return self._parse_tag_table(inner)
        if tag == "tr":
            return Block(type="table", rows=[_split_tag_cells(inner)], header=False)
        if tag == "quote":
            return Block(type="quote", children=self.parse_sub(inner))
        if tag == "callout":
            return Block(type="callout", icon=_attr(attrs, "icon"), children=self.parse_sub(inner))
        if tag == "toggle":
            heading = _attr(attrs, "heading") or "h2"
            level = int(heading[1]) if re.match(r"h[1-4]$", heading) else 2
            lines = inner.replace("\r", "").split("\n")
            while lines and not lines[0].strip():
                lines.pop(0)
            title = lines.pop(0).strip() if lines else ""
            rest = "\n".join(lines).strip("\n")
            return Block(type="toggle", level=level, title=title, children=self.parse_sub(rest))
        if tag in ("columns", "column", "tabs", "tab", "synced-block"):
            return Block(type="container", children=self.parse_sub(inner))
        if tag == "meeting-notes":
            return Block(type="container", children=self.parse_sub(inner))
        if tag in ("ul", "ol"):
            return Block(type="list", ordered=tag == "ol", items=self._parse_tag_list_items(inner))
        if tag in ("page", "folder", "database"):
            title = _strip_emph(inner.strip()) or _attr(attrs, "title")
            return Block(type="page", url=_attr(attrs, "url"), title=title)
        if tag in ("bookmark", "embed", "external_object_instance"):
            url = _attr(attrs, "source") or _attr(attrs, "url")
            return Block(type="embed", url=url, title=_strip_emph(inner.strip()))
        if tag in ("pdf", "file", "video", "audio"):
            url = _attr(attrs, "source") or _attr(attrs, "url")
            return Block(type="embed", url=url, title=_strip_emph(inner.strip()))
        if tag == "equation":
            return Block(type="equation", text=_strip_emph(inner.strip()))
        if tag == "unknown":
            alt = _attr(attrs, "alt")
            return Block(
                type="unknown",
                url=_attr(attrs, "url"),
                title=(f"不支持的内容块（{alt}）" if alt else "不支持的内容块"),
            )
        # 未知标签：内容保留
        return Block(type="container", children=self.parse_sub(inner)) if inner.strip() else None

    def parse_sub(self, text: str) -> list[Block]:
        sub = MarkdownParser(text)
        return sub.parse()

    def _parse_quote(self) -> Block:
        lines: list[str] = []
        while not self.eof():
            ln = self.line()
            if not ln.lstrip().startswith(">"):
                break
            body = re.sub(r"^\s*>\s?", "", ln)
            if not body.strip() and lines:
                lines.append("")
            elif body.strip():
                lines.append(body.rstrip())
            self.advance()
        return Block(type="quote", children=self.parse_sub("\n".join(lines)))

    def _parse_paragraph(self) -> Block:
        parts: list[tuple[str, bool]] = []
        while not self.eof():
            ln = self.line()
            if not ln.strip():
                break
            if parts and _line_starts_block(ln):
                break
            stripped = ln.rstrip()
            hard_break = stripped.endswith("\\")
            if hard_break:
                stripped = stripped[:-1].rstrip()
            parts.append((stripped, hard_break))
            self.advance()
        # 软换行等价空格；硬换行（行尾 \）保留 \n，渲染时变 <br>
        text = ""
        for idx, (line, hard) in enumerate(parts):
            text += line
            if idx < len(parts) - 1:
                text += "\n" if hard else " "
        return Block(type="p", text=text.strip())

    def _parse_pipe_table(self) -> Block:
        raw_lines: list[str] = []
        while not self.eof():
            ln = self.line()
            if not ln.strip() or "|" not in ln:
                break
            raw_lines.append(ln)
            self.advance()
        header = False
        rows: list[list[str]] = []
        for idx, ln in enumerate(raw_lines):
            if _TABLE_SEP_RE.match(ln):
                header = True
                continue
            cells = _split_pipe_row(ln)
            if not rows and header is False and idx == 0:
                rows.append(cells)
            else:
                rows.append(cells)
        return Block(type="table", rows=rows, header=header)

    def _parse_tag_table(self, inner: str) -> Block:
        rows: list[list[str]] = []
        header = False
        for tr in re.finditer(r"<tr\b[^<>]*?>(.*?)</tr>", inner, re.S | re.I):
            cells: list[str] = []
            for cell in re.finditer(r"<t([hd])\b[^<>]*?>(.*?)</t\1>", tr.group(1), re.S | re.I):
                if cell.group(1).lower() == "h":
                    header = True
                cells.append(cell.group(2).strip())
            if cells:
                rows.append(cells)
        return Block(type="table", rows=rows, header=header)

    def _parse_tag_list_items(self, inner: str) -> list[dict]:
        items: list[dict] = []
        pos = 0
        while pos < len(inner):
            m = re.search(r"<li\b", inner[pos:], re.I)
            if not m:
                break
            start = pos + m.start()
            scanned = _scan_container_text(inner, start, "li")
            if not scanned:
                pos = start + 3
                continue
            body, pos = scanned
            checked = None
            body = re.sub(r"^\s*<p\s*/>\s*", "", body, flags=re.I)
            title, rest = _split_first_paragraph(body)
            mchk = re.match(r"^\[([ xX])\]\s*", title)
            if mchk:
                checked = mchk.group(1).lower() == "x"
                title = re.sub(r"^\[[ xX]\]\s*", "", title)
            items.append({"text": title, "checked": checked, "children": self.parse_sub(rest)})
        return items

    def _parse_list(self) -> Block:
        first = self.line()
        m = _LIST_RE.match(first)
        assert m
        base_indent = len(m.group("indent").expandtabs(4))
        ordered = bool(re.match(r"\d", m.group("marker")))
        items: list[dict] = []
        while not self.eof():
            self.skip_blank()
            if self.eof():
                break
            ln = self.line()
            m = _LIST_RE.match(ln)
            if not m:
                break
            indent = len(m.group("indent").expandtabs(4))
            if indent != base_indent or bool(re.match(r"\d", m.group("marker"))) != ordered:
                break
            rest = m.group("rest").strip()
            checked = None
            if re.match(r"^\[[ xX]\]\s+", rest):
                checked = rest[1].lower() == "x"
                rest = re.sub(r"^\[[ xX]\]\s+", "", rest)
            self.advance()
            item_lines: list[str] = []
            text_parts = [rest]
            content_indent = base_indent + len(m.group("marker")) + 1
            while not self.eof():
                if not self.line().strip():
                    # 空行：后面还是本条目的更深层内容就继续，否则结束
                    save = self.pos
                    self.skip_blank()
                    if self.eof():
                        break
                    nxt = self.line()
                    nind = len(re.match(r"^[ \t]*", nxt).group(0).expandtabs(4))
                    if nind > base_indent:
                        item_lines.append("")
                        continue
                    self.pos = save
                    break
                nxt = self.line()
                nind = len(re.match(r"^[ \t]*", nxt).group(0).expandtabs(4))
                nm = _LIST_RE.match(nxt)
                if nind <= base_indent:
                    if nm and nind == base_indent:
                        break
                    if nind < base_indent:
                        break
                    text_parts.append(nxt.strip())
                    self.advance()
                    continue
                # 更深层：去缩进后作为子块
                dedent = min(nind, content_indent) if nind >= content_indent else base_indent
                item_lines.append(nxt[dedent:] if len(nxt) > dedent else nxt.lstrip())
                self.advance()
            children = self.parse_sub("\n".join(item_lines)) if any(l.strip() for l in item_lines) else []
            items.append({"text": " ".join(p for p in text_parts if p), "checked": checked, "children": children})
            # 跳过列表项之间的空行
        return Block(type="list", ordered=ordered, items=items)


def _line_starts_block(line: str) -> bool:
    if not line.strip():
        return True
    if _HEADING_RE.match(line.strip()) or _DIVIDER_RE.match(line.strip()):
        return True
    if re.match(r"^\s*`{3,}", line):
        return True
    if line.lstrip().startswith(">"):
        return True
    if _LIST_RE.match(line):
        return True
    if _IMAGE_MD_RE.match(line.strip()):
        return True
    if "|" in line:
        return True  # 表格行由上层处理；避免段落吞掉表格
    stripped = line.strip()
    if stripped.startswith("<"):
        m = _TAG_AT_LINE_RE.match(stripped)
        if m and m.group(1).lower() in ALL_BLOCK_TAGS:
            return True
    return False


def _split_pipe_row(line: str) -> list[str]:
    s = line.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|") and not s.endswith("\\|"):
        s = s[:-1]
    cells: list[str] = []
    buf = ""
    i = 0
    while i < len(s):
        ch = s[i]
        if ch == "\\" and i + 1 < len(s) and s[i + 1] == "|":
            buf += "|"
            i += 2
            continue
        if ch == "|":
            cells.append(buf.strip())
            buf = ""
        else:
            buf += ch
        i += 1
    cells.append(buf.strip())
    return cells


def _split_tag_cells(inner: str) -> list[str]:
    cells = []
    for cell in re.finditer(r"<t([hd])\b[^<>]*?>(.*?)</t\1>", inner, re.S | re.I):
        cells.append(cell.group(2).strip())
    return cells


def _split_first_paragraph(inner: str) -> tuple[str, str]:
    """容器块（toggle/li）里：第一段文字 vs 后面的子块。"""
    lines = inner.replace("\r", "").split("\n")
    while lines and not lines[0].strip():
        lines.pop(0)
    buf: list[str] = []
    rest_start = 0
    for i, ln in enumerate(lines):
        if not ln.strip():
            rest_start = i + 1
            break
        buf.append(ln.strip())
    else:
        return " ".join(buf).strip(), ""
    rest = "\n".join(lines[rest_start:]).strip("\n")
    return " ".join(buf).strip(), rest


def _strip_emph(text: str) -> str:
    s = re.sub(r"</?(?:b|i|s|u|mark|sub|sup|span|br)\b[^<>]*?>", "", text)
    s = _ESCAPE_RE.sub(r"\1", s)
    return s.strip()


# ---------------------------------------------------------------- cleaning

def _block_plain(block: Block) -> str:
    if block.type in ("p", "h", "equation"):
        return _strip_inline(block.text)
    if block.type == "toggle":
        return _strip_inline(block.title)
    if block.type == "list":
        return " ".join(_strip_inline(i["text"]) for i in block.items)
    if block.type == "table":
        return " ".join(_strip_inline(c) for row in block.rows for c in row)
    if block.type in ("quote", "callout", "container", "toggle"):
        return " ".join(_block_plain(c) for c in block.children)
    if block.type in ("embed", "page", "unknown"):
        return block.title or block.url
    return block.code if block.type in ("code", "mermaid") else ""


def _protect_escapes(text: str) -> str:
    r"""把 \+标点 换成 PUA sentinel，避免后续去标记/清标签时误删。"""
    return _ESCAPE_RE.sub(lambda m: chr(0xE000 + ord(m.group(1))), text or "")


def _restore_escapes(text: str) -> str:
    return re.sub("[\ue000-\ue07e]", lambda m: chr(ord(m.group(0)) - 0xE000), text)


def _strip_inline(text: str) -> str:
    s = _protect_escapes(text)
    s = re.sub(r"<[^<>]+>", "", s)
    s = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", s)
    s = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", s)
    s = re.sub(r"[`*_~]{1,3}", "", s)
    s = _restore_escapes(s)
    return re.sub(r"\s+", " ", s).strip()


_EMOJI_STRIP_RE = re.compile(
    "^[\\s\U0001F000-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF\uFE0F\u200D]+"
)


def strip_emoji_prefix(text: str) -> str:
    prev = None
    s = text or ""
    while s and s != prev:
        prev = s
        s = _EMOJI_STRIP_RE.sub("", s)
    return s.strip()


def _norm_title(text: str) -> str:
    s = strip_emoji_prefix(text)
    s = re.sub(r"[\s\W_]+", "", s, flags=re.U)
    return s.lower()


def _is_title_duplicate(text: str, title: str) -> bool:
    a, b = _norm_title(text), _norm_title(title)
    if not a or not b:
        return False
    if a == b:
        return True
    if len(a) >= 6 and len(b) >= 4 and (a.startswith(b) or b.startswith(a)):
        return True
    # 相似度（中文标题差一两个字很常见）
    import difflib
    return difflib.SequenceMatcher(None, a, b).ratio() >= 0.62


def clean_blocks(blocks: list[Block], title: str, cfg: dict | None = None) -> list[Block]:
    cfg = cfg or {}
    lead_prefixes = tuple(cfg.get("drop_lead_para_prefixes") or ["导语｜", "导语|"])
    byline_markers = tuple(cfg.get("byline_markers") or ["授课：", "中文讲解文章", "｜授课", "——"])
    status_headings = set(cfg.get("drop_status_headings") or ["状态", "状态更新"])
    tail_patterns = [re.compile(p) for p in (cfg.get("drop_tail_patterns") or [r"^第\s*[一二三四五六七八九十百零0-9]+\s*讲\s*完[。.]?$"])]

    # 1.── preamble：删 h1 / 导语 / 页眉署名 / 标题重复
    out: list[Block] = []
    seen_heading = False
    preamble_idx = 0
    for b in blocks:
        if b.type == "h" and b.level >= 2:
            seen_heading = True
        if not seen_heading:
            plain = _block_plain(b).strip()
            if b.type == "h" and b.level == 1:
                continue
            if b.type == "toc":
                continue
            if b.type == "p" and plain.startswith(lead_prefixes):
                continue
            if b.type == "p" and any(mk in plain for mk in byline_markers):
                continue
            if b.type == "p" and preamble_idx <= 2 and _is_title_duplicate(plain, title):
                preamble_idx += 1
                continue
            if b.type == "p" and not plain:
                continue
            preamble_idx += 1
        out.append(b)

    # 2.── 递归清理容器
    def clean_nested(items: list[Block]) -> list[Block]:
        res = []
        for b in items:
            if b.type == "toc":
                continue
            if b.type in ("quote", "callout", "container", "toggle"):
                b.children = clean_nested(b.children)
            elif b.type == "list":
                for it in b.items:
                    it["children"] = clean_nested(it["children"])
            res.append(b)
        return res
    out = clean_nested(out)

    # 3.── H2「状态」整段删除
    res: list[Block] = []
    skip_level: int | None = None
    for b in out:
        if skip_level is not None:
            if b.type == "h" and b.level <= skip_level:
                skip_level = None
            else:
                continue
        if b.type == "h" and any(_block_plain(b).strip().startswith(h) for h in status_headings):
            skip_level = b.level
            continue
        res.append(b)
    out = res

    # 4.── 结尾残句：可能是独立段落，也可能粘在最后一段末尾（如「…第十二讲完。」）
    while out and (out[-1].type == "hr" or (out[-1].type == "p" and not _block_plain(out[-1]).strip())):
        out.pop()
    if out and out[-1].type == "p":
        tail_plain = _block_plain(out[-1]).strip()
        if any(p.match(tail_plain) for p in tail_patterns):
            out.pop()
        else:
            stripped = re.sub(
                r"\s*第\s*[一二三四五六七八九十百零0-9]+\s*讲\s*完[。.]?\s*$", "", out[-1].text
            ).strip()
            if stripped != out[-1].text.strip():
                if stripped:
                    out[-1].text = stripped
                else:
                    out.pop()

    # 5.── 空段落 / 纯 emoji 段落
    res = []
    for b in out:
        if b.type == "p":
            plain = _block_plain(b).strip()
            plain_wo_emoji = _EMOJI_STRIP_RE.sub("", plain).strip()
            if not plain_wo_emoji and not re.search(r"[A-Za-z0-9\u4e00-\u9fff]", plain):
                continue
        res.append(b)
    return res


def attach_captions(blocks: list[Block]) -> list[Block]:
    """图片「图注：/图：」与 mermaid 前置「图N：」图题归一（R5/R6）。"""
    out: list[Block] = []
    i = 0
    while i < len(blocks):
        b = blocks[i]
        if b.type == "image":
            cap = _caption_from(b.caption or b.alt)
            if not cap and i + 1 < len(blocks):
                nxt = blocks[i + 1]
                if nxt.type == "p" and _caption_from(_block_plain(nxt)):
                    cap = nxt.text.strip()
                    i += 1
                elif nxt.type == "list" and nxt.items:
                    first = nxt.items[0]
                    if _caption_from(_strip_inline(first["text"])):
                        cap = first["text"].strip()
                        nxt.items = nxt.items[1:]
                        if not nxt.items:
                            i += 1
            b.caption = cap or ""
            out.append(b)
        elif b.type == "code" and _is_mermaid_code(b):
            b.type = "mermaid"
            if out and out[-1].type == "p":
                prev_plain = _block_plain(out[-1]).strip()
                if _MM_CAPTION_RE.match(prev_plain):
                    b.caption = out.pop().text.strip()
            out.append(b)
        else:
            out.append(b)
        i += 1
    return out


def _caption_from(text: str) -> str:
    s = _strip_inline(text or "")
    if _CAPTION_RE.match(s):
        return s
    return ""


def _is_mermaid_code(block: Block) -> bool:
    if block.type != "code":
        return False
    if block.lang == "mermaid":
        return True
    code = (block.code or "").lstrip()
    return bool(_MERMAID_HINT_RE.match(code))


# ---------------------------------------------------------------- render

def _heading_id(counter: list[int]) -> str:
    counter[0] += 1
    return f"kb-s{counter[0]}"


def _plain_words(blocks: list[Block]) -> int:
    text = " ".join(_block_plain(b) for b in blocks)
    return len(text.replace(" ", ""))


def render_article(
    article_id: str,
    title: str,
    course_label: str,
    updated: str,
    blocks: list[Block],
    linkmap: dict[str, dict] | None = None,
) -> tuple[str, dict[str, Any]]:
    """返回 (article HTML 片段, stats)。stats: words/mermaid/mermaid_failed/images。"""
    inline = InlineRenderer(linkmap)
    counter = [0]
    stats: dict[str, Any] = {"words": 0, "mermaid": 0, "mermaid_failed": 0, "images": []}
    seen_media: set[str] = set()

    def render_blocks(items: list[Block]) -> str:
        return "".join(render_block(b) for b in items)

    def render_block(b: Block) -> str:
        if b.type == "p":
            inner = inline.render(b.text)
            return f"<p>{inner}</p>" if inner.strip() else ""
        if b.type == "h":
            level = min(max(b.level, 2), 4)
            inner = inline.render(b.text)
            return f'<h{level} id="{_heading_id(counter)}">{inner}</h{level}>'
        if b.type == "hr":
            return "<hr>"
        if b.type == "list":
            tag = "ol" if b.ordered else "ul"
            buf = [f"<{tag}>"]
            for it in b.items:
                check = ""
                if it.get("checked") is True:
                    check = "☑ "
                elif it.get("checked") is False:
                    check = "☐ "
                text = check + inline.render(it["text"])
                child = render_blocks(it.get("children") or [])
                buf.append(f"<li>{text}{child}</li>")
            buf.append(f"</{tag}>")
            return "".join(buf)
        if b.type == "quote":
            return "<blockquote>" + render_blocks(b.children) + "</blockquote>"
        if b.type == "callout":
            icon = f'<span class="kb-note-ico" aria-hidden="true">{esc(b.icon)}</span>' if b.icon else ""
            return f'<aside class="kb-note">{icon}' + render_blocks(b.children) + "</aside>"
        if b.type in ("container", "toggle"):
            head = ""
            if b.type == "toggle" and b.title:
                inner = inline.render(b.title)
                level = min(max(b.level or 2, 2), 4)
                head = f'<h{level} id="{_heading_id(counter)}">{inner}</h{level}>'
            return head + render_blocks(b.children)
        if b.type == "code":
            lang = (b.lang or "").strip()
            cls = f' class="language-{esc(lang)}"' if lang else ""
            return f"<pre><code{cls}>{esc(b.code)}</code></pre>"
        if b.type == "mermaid":
            if b.svg:
                cap = f"<figcaption>{inline.render(b.caption)}</figcaption>" if b.caption else ""
                stats["mermaid"] += 1
                return f'<figure class="kb-mm">{b.svg}{cap}</figure>'
            stats["mermaid_failed"] += 1
            return f'<pre><code class="language-mermaid">{esc(b.code)}</code></pre>'
        if b.type == "table":
            if not b.rows:
                return ""
            buf = ['<div class="kb-tw"><table>']
            body_start = 0
            if b.header:
                buf.append("<thead><tr>")
                for cell in b.rows[0]:
                    buf.append(f"<th>{inline.render(cell)}</th>")
                buf.append("</tr></thead>")
                body_start = 1
            buf.append("<tbody>")
            for row in b.rows[body_start:]:
                buf.append("<tr>")
                for cell in row:
                    buf.append(f"<td>{inline.render(cell)}</td>")
                buf.append("</tr>")
            buf.append("</tbody></table></div>")
            return "".join(buf)
        if b.type == "image":
            media = b.media
            if not media:
                return ""
            sha = media["sha"]
            if sha in seen_media:
                return ""
            seen_media.add(sha)
            alt = _strip_inline(b.alt or "")
            cap = _strip_inline(b.caption or "")
            cap = re.sub(r"^(图注|图)\s*[：:]\s*", "", cap)
            figcap = f"<figcaption>图注：{inline.render(cap)}</figcaption>" if cap else ""
            stats["images"].append({"sha": sha, "ext": media.get("ext", "webp"),
                                    "w": int(media.get("w", 0)), "h": int(media.get("h", 0))})
            return (
                f'<figure><img src="/kb/i/{esc(sha)}.{esc(media.get("ext", "webp"))}" '
                f'width="{int(media.get("w", 0))}" height="{int(media.get("h", 0))}" '
                f'loading="lazy" alt="{esc(alt)}">{figcap}</figure>'
            )
        if b.type == "page":
            if b.url:
                return f"<p>{inline.link(b.url, esc(b.title or b.url))}</p>"
            return f"<p>{esc(b.title)}</p>" if b.title else ""
        if b.type == "embed":
            if b.url and not _is_notion_url(b.url):
                return f'<p><a href="{esc(b.url)}" data-external="1">{esc(b.title or b.url)}</a></p>'
            return f"<p>{esc(b.title)}</p>" if b.title else ""
        if b.type == "equation":
            return f"<pre><code>{esc(_strip_inline(b.text))}</code></pre>"
        if b.type == "unknown":
            return f"<p>{esc(b.title or '不支持的内容块')}</p>"
        return ""

    body = render_blocks(blocks)
    head = (
        f'<article class="kb-art" data-id="{esc(article_id)}">\n'
        f"<h1>{esc(title)}</h1>\n"
        f'<p class="kb-byline">{esc(course_label)} · 更新于 {esc(updated)}</p>'
    )
    stats["words"] = _plain_words(blocks)
    return head + "\n" + body + "\n</article>", stats


def media_key(code: str) -> str:
    import hashlib
    return hashlib.sha1((code or "").encode("utf-8")).hexdigest()[:16]


# ---------------------------------------------------------------- public api

def parse_markdown(text: str) -> list[Block]:
    return MarkdownParser(text).parse()


def parse_blocks(text: str) -> list[Block]:
    return MarkdownParser(text).parse()
