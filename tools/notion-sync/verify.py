#!/usr/bin/env python3
"""校验同步产物 dist/ 是否符合 docs/notion-kb-contract.md v1。

用法：python verify.py [--dist DIR] [--json]
通过退出码 0，失败 1；打印 PASS/FAIL 与统计。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import struct
import sys
from pathlib import Path

DIST_DEFAULT = Path(__file__).resolve().parent / "dist"
BAD_URL_PATTERNS = [
    r"notion\.so", r"notion\.site", r"app\.notion\.com", r"notion-file-block",
    r"secure\.notion-static", r"prod-files-secure", r"amazonaws\.com",
    r"X-Amz-", r"notion\.com",
]
FORBIDDEN_TAGS = ["<script", "<iframe", "<object", "<embed", "<style"]
IMG_SRC_RE = re.compile(r'<img\b[^>]*\bsrc="([^"]+)"[^>]*>', re.I)
LINK_RE = re.compile(r'<a\b[^>]*\bhref="([^"]+)"[^>]*>', re.I)
KB_LINK_RE = re.compile(r"^/kb/a/([a-z0-9-]+)/([a-z0-9-]+)\.html$")


class Checker:
    def __init__(self, dist: Path):
        self.dist = dist
        self.errors: list[str] = []
        self.stats: dict = {}
        self.escape_residuals = 0

    def fail(self, msg: str) -> None:
        self.errors.append(msg)

    # -------------------------------------------------------------- utils
    def _read(self, path: Path) -> str:
        return path.read_text(encoding="utf-8")

    def _strip_svg(self, html: str) -> str:
        """mermaid 内联 SVG 允许自带 <style>；检查其余部分。"""
        html = re.sub(r"<style\b[\s\S]*?</style>", "", html, flags=re.I)
        return re.sub(r"<svg\b[\s\S]*?</svg>", "", html, flags=re.I)

    def _is_webp(self, path: Path) -> bool:
        try:
            head = path.read_bytes()[:12]
        except OSError:
            return False
        return len(head) == 12 and head[:4] == b"RIFF" and head[8:12] == b"WEBP"

    # -------------------------------------------------------------- checks
    def run(self) -> None:
        if not self.dist.is_dir():
            return self.fail(f"dist 不存在：{self.dist}")
        index_path = self.dist / "index.json"
        status_path = self.dist / "status.json"
        if not index_path.is_file():
            return self.fail("缺少 index.json")
        if not status_path.is_file():
            self.fail("缺少 status.json")
        try:
            index = json.loads(self._read(index_path))
        except ValueError as exc:
            return self.fail(f"index.json 解析失败：{exc}")
        status = {}
        if status_path.is_file():
            try:
                status = json.loads(self._read(status_path))
            except ValueError as exc:
                self.fail(f"status.json 解析失败：{exc}")

        # index schema
        for key, typ in (("fmt", int), ("release", str), ("generated_at", str),
                         ("articles_total", int), ("courses", list)):
            if key not in index:
                self.fail(f"index.json 缺字段 {key}")
            elif not isinstance(index[key], typ):
                self.fail(f"index.{key} 类型应为 {typ.__name__}")
        if index.get("fmt") != 1:
            self.fail(f"index.fmt={index.get('fmt')}，契约为 1")
        release = index.get("release") or ""
        if not re.match(r"^\d{8}T\d{6}$", release or ""):
            self.fail(f"release 格式不对：{release}")
        for key in ("generated_at", "release", "articles"):
            if key not in status:
                self.fail(f"status.json 缺字段 {key}")

        articles = []
        for course in index.get("courses") or []:
            cid = course.get("id") or ""
            if not re.match(r"^[a-z0-9-]+$", cid):
                self.fail(f"course.id 不合规：{cid!r}")
            for key in ("title", "order", "articles"):
                if key not in course:
                    self.fail(f"course {cid} 缺字段 {key}")
            for art in course.get("articles") or []:
                articles.append((course, art))
        if len(articles) != index.get("articles_total"):
            self.fail(f"articles_total={index.get('articles_total')} 与实际 {len(articles)} 不符")

        media_refs: set[str] = set()
        shas: dict[str, str] = {}
        mermaid_ok = mermaid_fallback = 0
        link_targets: set[str] = set()
        total_html_bytes = 0

        for course, art in articles:
            cid, aid = course.get("id") or "", art.get("id") or ""
            if not re.match(r"^[a-z0-9-]+$", aid):
                self.fail(f"article.id 不合规：{aid!r}（course {cid}）")
            for key in ("title", "order", "updated", "sha", "words", "read_min",
                        "path", "mermaid", "images"):
                if key not in art:
                    self.fail(f"{cid}/{aid} 缺字段 {key}")
            rel = art.get("path") or ""
            if not rel.startswith(f"releases/{release}/a/{cid}/"):
                self.fail(f"{cid}/{aid} path 不在当前 release：{rel}")
            html_path = self.dist / rel
            if not html_path.is_file():
                self.fail(f"{cid}/{aid} 正文文件不存在：{rel}")
                continue
            html = self._read(html_path)
            total_html_bytes += len(html.encode("utf-8"))
            # 内容 sha：16 位小写 hex、与文件字节一致、同 release 唯一
            sha = art.get("sha") or ""
            if not re.fullmatch(r"[0-9a-f]{16}", sha):
                self.fail(f"{cid}/{aid} sha 不是 16 位小写 hex：{sha!r}")
            else:
                actual = hashlib.sha256(html_path.read_bytes()).hexdigest()[:16]
                if actual != sha:
                    self.fail(f"{cid}/{aid} sha 与 HTML 文件不符（index {sha} / file {actual}）")
                if sha in shas:
                    self.fail(f"{cid}/{aid} sha 与 {shas[sha]} 重复：{sha}")
                else:
                    shas[sha] = f"{cid}/{aid}"
            if '<article class="kb-art"' not in html:
                self.fail(f"{cid}/{aid} 缺少 <article class=\"kb-art\">")
            if not re.search(r"<h1>.+?</h1>", html, re.S):
                self.fail(f"{cid}/{aid} 缺少 h1")
            if 'class="kb-byline"' not in html:
                self.fail(f"{cid}/{aid} 缺少 kb-byline")

            # 禁用内容
            scan = self._strip_svg(html)
            low = scan.lower()
            for pat in BAD_URL_PATTERNS:
                if re.search(pat, low):
                    self.fail(f"{cid}/{aid} 含 Notion/签名 URL：{pat}")
            for tag in FORBIDDEN_TAGS:
                if tag in low:
                    self.fail(f"{cid}/{aid} 含禁用标签 {tag}")
            if re.search(r"\son[a-z]+\s*=", low):
                self.fail(f"{cid}/{aid} 含 on* 事件属性")
            # CommonMark 转义不应残留在正文（代码块/行内代码/svg 里允许保留原样）
            scan_text = re.sub(r"<pre\b[\s\S]*?</pre>", "", html, flags=re.I)
            scan_text = re.sub(r"<code\b[\s\S]*?</code>", "", scan_text, flags=re.I)
            scan_text = re.sub(r"<svg\b[\s\S]*?</svg>", "", scan_text, flags=re.I)
            residual = re.findall(r"\\(?=[!\"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])", scan_text)
            if residual:
                self.escape_residuals += len(residual)
                self.fail(f"{cid}/{aid} 正文残留 Markdown 转义 {len(residual)} 处（如 {residual[:3]}）")
            if "导语｜" in html or "导语|" in html:
                self.fail(f"{cid}/{aid} 未清掉导语段")
            if re.search(r"授课：|中文讲解文章", html):
                self.fail(f"{cid}/{aid} 未清掉页眉署名")
            if re.search(r"第[一二三四五六七八九十百零0-9]+讲完[。.]?", html):
                self.fail(f"{cid}/{aid} 未清掉结尾残句")

            # 标题 id
            for m in re.finditer(r"<h([23])\b([^>]*)>", html):
                if 'id="kb-s' not in m.group(2):
                    self.fail(f"{cid}/{aid} h{m.group(1)} 缺 id")
                    break

            # 图片
            for src in IMG_SRC_RE.findall(html):
                if not src.startswith("/kb/i/"):
                    self.fail(f"{cid}/{aid} 图片 src 不合规：{src}")
                    continue
                sha = Path(src).stem
                media_refs.add(sha)
                mpath = self.dist / "media" / f"{sha}.webp"
                if not mpath.is_file():
                    self.fail(f"{cid}/{aid} 图片不存在：{mpath.name}")
                elif mpath.stat().st_size == 0:
                    self.fail(f"{cid}/{aid} 图片为空：{mpath.name}")
                elif not self._is_webp(mpath):
                    self.fail(f"{cid}/{aid} 图片不是 WebP：{mpath.name}")
                if not re.search(r'<img\b[^>]*\bwidth="\d+"[^>]*\bheight="\d+"', html):
                    self.fail(f"{cid}/{aid} img 缺 width/height")
                if 'loading="lazy"' not in html:
                    self.fail(f"{cid}/{aid} img 缺 loading=lazy")

            # mermaid：每个 figure 必须浅/暗两版，viewBox 完全一致；不允许旧结构
            mm_pairs = 0
            for fig in re.findall(r'<figure class="kb-mm">([\s\S]*?)</figure>', html):
                svgs = re.findall(r"<svg\b[^>]*>", fig)
                if len(svgs) != 2:
                    self.fail(f"{cid}/{aid} mermaid figure 里 svg 数 {len(svgs)}（应为 2：light/dark）")
                    continue
                classes = []
                vbs = []
                ok_svg = True
                for tag in svgs:
                    cm = re.search(r'class="([^"]*)"', tag)
                    vm = re.search(r'viewBox="([^"]+)"', tag)
                    classes.append(cm.group(1) if cm else "")
                    vbs.append(vm.group(1) if vm else "")
                    if re.search(r"\swidth=", tag):
                        self.fail(f"{cid}/{aid} mermaid svg 仍带 width")
                        ok_svg = False
                    if not vm:
                        self.fail(f"{cid}/{aid} mermaid svg 缺 viewBox")
                        ok_svg = False
                if "kb-mm-light" not in classes[0] or "kb-mm-dark" not in classes[1]:
                    self.fail(f"{cid}/{aid} mermaid svg class 不是 light/dark 顺序：{classes}")
                    ok_svg = False
                if vbs[0] != vbs[1]:
                    self.fail(f"{cid}/{aid} mermaid light/dark viewBox 不一致：{vbs}")
                    ok_svg = False
                if ok_svg:
                    mm_pairs += 1
            mm_fallback = len(re.findall(r'<pre><code class="language-mermaid">', html))
            total_svg = len(re.findall(r"<svg\b[^>]*>", html))
            if total_svg != mm_pairs * 2:
                self.fail(f"{cid}/{aid} mermaid svg 总数 {total_svg} != figure 数 {mm_pairs}×2（旧结构/单版）")
            if "kb-mm-wide" in html:
                self.fail(f"{cid}/{aid} 出现已废弃的 kb-mm-wide")
            if mm_pairs + mm_fallback != int(art.get("mermaid") or 0):
                self.fail(f"{cid}/{aid} mermaid 数 {mm_pairs}+{mm_fallback} 与 index {art.get('mermaid')} 不符")
            mermaid_ok += mm_pairs
            mermaid_fallback += mm_fallback

            # 内链
            for href in LINK_RE.findall(html):
                m = KB_LINK_RE.match(href)
                if m:
                    link_targets.add((m.group(1), m.group(2)))
                elif href.startswith("/kb/"):
                    self.fail(f"{cid}/{aid} 内部链接格式不对：{href}")
                elif href.startswith(("http://", "https://")):
                    if "data-external=\"1\"" not in html:
                        pass  # 逐个 a 标签校验由下方完成

            # 外链必须有 data-external（按 <a …> 整体判断）
            for a_tag in re.findall(r"<a\b[^>]*>", html):
                href_m = re.search(r'href="([^"]+)"', a_tag)
                if not href_m:
                    continue
                href = href_m.group(1)
                if href.startswith(("http://", "https://")) and 'data-external="1"' not in a_tag:
                    self.fail(f"{cid}/{aid} 外链缺 data-external：{href[:80]}")
                    break
                if href.startswith("/kb/a/") and "data-kb-article=" not in a_tag:
                    self.fail(f"{cid}/{aid} 内链缺 data-kb-article：{href}")
                    break

            # images 元数据
            for img in art.get("images") or []:
                if img.get("sha") not in media_refs:
                    self.fail(f"{cid}/{aid} index images 未在 HTML 中出现：{img.get('sha')}")
                if img.get("ext") != "webp":
                    self.fail(f"{cid}/{aid} index 图片 ext 非 webp")

        # 内链目标必须存在
        article_keys = {(c.get("id"), a.get("id")) for c, a in articles}
        for cid, aid in sorted(link_targets):
            if (cid, aid) not in article_keys:
                self.fail(f"内链指向不存在的文章：/kb/a/{cid}/{aid}.html")

        # 媒体目录里不允许多余非 webp 文件
        media_dir = self.dist / "media"
        if media_dir.is_dir():
            for p in media_dir.iterdir():
                if p.is_file() and p.suffix != ".webp":
                    self.fail(f"media/ 出现非 webp 文件：{p.name}")

        # media 总数/字节
        media_files = list(media_dir.glob("*.webp")) if media_dir.is_dir() else []
        media_bytes = sum(p.stat().st_size for p in media_files)
        total_bytes = media_bytes + total_html_bytes
        self.stats = {
            "dist": str(self.dist),
            "release": release,
            "articles": len(articles),
            "courses": len(index.get("courses") or []),
            "media_files": len(media_files),
            "media_bytes": media_bytes,
            "html_bytes": total_html_bytes,
            "total_bytes": total_bytes,
            "mermaid_svg": mermaid_ok,
            "mermaid_fallback": mermaid_fallback,
            "internal_links": len(link_targets),
            "escape_residuals": self.escape_residuals,
            "article_shas": len(shas),
        }

    def report(self) -> bool:
        ok = not self.errors
        print(f"{'PASS' if ok else 'FAIL'} kb-contract-v1  {self.stats.get('dist')}")
        for key in ("release", "articles", "courses", "media_files", "media_bytes",
                    "html_bytes", "total_bytes", "mermaid_svg", "mermaid_fallback",
                    "internal_links", "escape_residuals", "article_shas"):
            if key in self.stats:
                value = self.stats[key]
                if key.endswith("_bytes"):
                    value = f"{value} ({value / 1024 / 1024:.2f}MB)"
                print(f"  {key}: {value}")
        if not ok:
            print(f"  errors: {len(self.errors)}")
            for err in self.errors[:60]:
                print(f"  - {err}")
            if len(self.errors) > 60:
                print(f"  ... 还有 {len(self.errors) - 60} 条")
        return ok


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="校验书边译课程板块 dist 产物")
    parser.add_argument("--dist", default=str(DIST_DEFAULT))
    parser.add_argument("--json", action="store_true", help="额外输出机器可读结果")
    args = parser.parse_args(argv)
    checker = Checker(Path(args.dist).resolve())
    checker.run()
    ok = checker.report()
    if args.json:
        print(json.dumps({"ok": ok, "stats": checker.stats, "errors": checker.errors},
                         ensure_ascii=False))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
