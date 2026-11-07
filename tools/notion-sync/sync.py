#!/usr/bin/env python3
"""书边译「课程」板块同步管线：Notion 知识库 → 静态内容包（契约 v1）。

用法：
  python sync.py                      # 真实模式：增量（需要 NOTION_TOKEN）
  python sync.py --full               # 忽略 state 全量重建
  python sync.py --dry-run            # 只构建 dist，不写 state、不发布
  python sync.py --from-fixtures DIR  # fixture 模式（无 token；跳过 API/图片下载）
  python sync.py --limit 4            # 只处理前 N 篇（开发用）
  python sync.py --publish            # 构建后用 rsync 发布（config.publish.enabled + KB_REMOTE_DIR）

产物：dist/{index.json,status.json,media/..,releases/<release>/a/<course>/<article>.html}
不打印任何 token。真实模式的 token 从环境变量 NOTION_TOKEN 读（run.sh 负责 source 600 文件）。
"""
from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import fcntl
import hashlib
import io
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
import traceback
from pathlib import Path
from typing import Any

import requests
import yaml
from PIL import Image, ImageOps

import mdparse
from mdparse import Block, parse_markdown, clean_blocks, attach_captions, render_article, strip_emoji_prefix

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
DEFAULT_CONFIG = HERE / "config.yaml"
CHROME_DEFAULT = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
FONT_DEFAULT = REPO / "app/src/main/assets/web/fonts/fusion-pixel.woff2"
MEDIA_LIMIT_BYTES = 30 * 1024 * 1024

# ---------------------------------------------------------------- log / util


def log(msg: str, *, err: bool = False) -> None:
    line = f"[{dt.datetime.now().strftime('%m-%d %H:%M:%S')}] {msg}"
    print(line, file=sys.stderr if err else sys.stdout, flush=True)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def html_sha(data: bytes) -> str:
    """文章 HTML 字节的 sha256 前 16 位（App 用它判断要不要重下正文）。"""
    return hashlib.sha256(data).hexdigest()[:16]


def now_local() -> dt.datetime:
    return dt.datetime.now().astimezone()


def release_id(when: dt.datetime) -> str:
    return when.strftime("%Y%m%dT%H%M%S")


def parse_iso(value: str) -> dt.datetime | None:
    if not value:
        return None
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def human_bytes(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.1f}{unit}" if unit != "B" else f"{n}B"
        n /= 1024.0
    return f"{n:.1f}GB"


def load_config(path: Path) -> dict:
    with path.open(encoding="utf-8") as fh:
        cfg = yaml.safe_load(fh) or {}
    cfg.setdefault("courses", [])
    cfg.setdefault("filters", {})
    cfg.setdefault("clean", {})
    cfg.setdefault("output", {})
    cfg.setdefault("mermaid", {})
    cfg.setdefault("publish", {})
    cfg.setdefault("notion", {})
    return cfg


def strip_title_prefix(title: str) -> str:
    return strip_emoji_prefix(title or "").strip()


def article_slug(page_id: str) -> str:
    """文章 id 直接用 Notion page_id（小写、带连字符，满足契约 [a-z0-9-]）。

    知识库里 page id 前缀高度重合（4107d604-ab11-…），取前 12 位会撞车；
    直接用完整 page_id 既稳定又唯一。
    """
    raw = norm_id(page_id)
    if len(raw) == 32:
        return f"{raw[0:8]}-{raw[8:12]}-{raw[12:16]}-{raw[16:20]}-{raw[20:32]}"
    fallback = re.sub(r"[^a-z0-9-]+", "-", (page_id or "").lower()).strip("-")
    if fallback:
        return fallback[:64]
    return (sha256_text(page_id or "x")[:12])


def norm_id(value: str) -> str:
    return re.sub(r"[^0-9a-f]", "", (value or "").lower())


# ---------------------------------------------------------------- notion api


class NotionError(Exception):
    pass


class NotionAuthError(NotionError):
    pass


class NotionClient:
    def __init__(self, cfg: dict, token: str):
        notion_cfg = cfg["notion"]
        self.base = (notion_cfg.get("api_base") or "https://api.notion.com").rstrip("/")
        self.version = notion_cfg.get("version") or "2026-03-11"
        self.timeout = int(notion_cfg.get("timeout") or 30)
        self.min_interval = 1.0 / max(0.5, float(notion_cfg.get("max_rps") or 3))
        self.token = token
        self.session = requests.Session()
        self.session.headers.update({
            "Authorization": f"Bearer {token}",
            "Notion-Version": self.version,
            "Content-Type": "application/json",
            "User-Agent": "shubian-notion-sync/1.0",
        })
        self.img_session = requests.Session()
        self.img_session.headers.update({"User-Agent": "shubian-notion-sync/1.0"})
        self.calls = 0
        self._last = 0.0

    def _wait(self) -> None:
        delta = time.monotonic() - self._last
        if delta < self.min_interval:
            time.sleep(self.min_interval - delta)
        self._last = time.monotonic()

    def request(self, method: str, path: str, *, params: dict | None = None,
                retries: int = 5) -> dict:
        url = path if path.startswith("http") else f"{self.base}{path}"
        last_err = ""
        for attempt in range(retries + 1):
            self._wait()
            try:
                resp = self.session.request(method, url, params=params, timeout=self.timeout)
            except requests.RequestException as exc:
                last_err = f"network: {exc.__class__.__name__}"
                if attempt >= retries:
                    raise NotionError(last_err) from exc
                time.sleep(min(2 ** attempt, 15))
                continue
            self.calls += 1
            if resp.status_code == 200:
                try:
                    return resp.json()
                except ValueError as exc:
                    raise NotionError("invalid json response") from exc
            if resp.status_code == 401:
                raise NotionAuthError("Notion token 无效或已失效（401），不重试")
            if resp.status_code in (429, 529):
                wait = _retry_after(resp, attempt)
                log(f"Notion {resp.status_code}，等待 {wait:.1f}s 重试", err=True)
                if attempt >= retries:
                    raise NotionError(f"rate limited after retries: {resp.status_code}")
                time.sleep(wait)
                continue
            if resp.status_code >= 500 and attempt < retries:
                time.sleep(min(2 ** attempt, 15))
                continue
            detail = ""
            try:
                data = resp.json()
                detail = data.get("message") or data.get("code") or ""
            except ValueError:
                detail = resp.text[:200]
            raise NotionError(f"Notion {resp.status_code}: {detail}")
        raise NotionError(last_err or "unknown notion error")

    def list_children(self, block_id: str) -> list[dict]:
        results: list[dict] = []
        cursor = None
        while True:
            params: dict[str, Any] = {"page_size": 100}
            if cursor:
                params["start_cursor"] = cursor
            data = self.request("GET", f"/v1/blocks/{norm_uuid(block_id)}/children", params=params)
            results.extend(data.get("results") or [])
            if not data.get("has_more"):
                break
            cursor = data.get("next_cursor")
            if not cursor:
                break
        return results

    def retrieve_page(self, page_id: str) -> dict:
        return self.request("GET", f"/v1/pages/{norm_uuid(page_id)}")

    def page_markdown(self, page_id: str) -> dict:
        return self.request(
            "GET", f"/v1/pages/{norm_uuid(page_id)}/markdown",
            params={"markdown_version": "v2"},
        )

    def download(self, url: str) -> bytes:
        for attempt in range(3):
            try:
                resp = self.img_session.get(url, timeout=90, stream=True)
            except requests.RequestException:
                if attempt >= 2:
                    raise
                time.sleep(2 ** attempt)
                continue
            if resp.status_code == 200:
                buf = io.BytesIO()
                total = 0
                for chunk in resp.iter_content(64 * 1024):
                    total += len(chunk)
                    if total > MEDIA_LIMIT_BYTES:
                        raise NotionError("image too large")
                    buf.write(chunk)
                return buf.getvalue()
            if resp.status_code in (403, 410) and attempt < 2:
                # signed URL 过期：调用方会用新的 markdown 重新取 URL
                raise NotionError("signed url expired")
            if resp.status_code >= 500 and attempt < 2:
                time.sleep(2 ** attempt)
                continue
            raise NotionError(f"image download {resp.status_code}")
        raise NotionError("image download failed")


def norm_uuid(value: str) -> str:
    raw = norm_id(value)
    if len(raw) == 32:
        return f"{raw[0:8]}-{raw[8:12]}-{raw[12:16]}-{raw[16:20]}-{raw[20:32]}"
    return value


def _retry_after(resp: requests.Response, attempt: int) -> float:
    raw = resp.headers.get("Retry-After")
    if raw:
        try:
            return max(0.5, float(raw))
        except ValueError:
            pass
    return min(2 ** attempt, 30) + 0.25


# ---------------------------------------------------------------- discovery


def title_exclusion_reason(title: str, cfg: dict) -> str | None:
    """返回排除原因（None=保留）。规则支持字符串或 {pattern, reason}。"""
    clean = strip_title_prefix(title)
    for entry in cfg["filters"].get("exclude_title_patterns") or []:
        if isinstance(entry, dict):
            pat = str(entry.get("pattern") or "")
            reason = str(entry.get("reason") or "标题命中排除规则")
        else:
            pat, reason = str(entry), "标题命中排除规则"
        if not pat:
            continue
        try:
            hit = re.search(pat, clean) is not None
        except re.error:
            hit = pat in clean
        if hit:
            return f"{reason}（匹配 /{pat}/）"
    return None


def is_filtered_title(title: str, cfg: dict) -> bool:
    return title_exclusion_reason(title, cfg) is not None


def is_filtered_icon(icon: str, cfg: dict) -> bool:
    return bool(icon) and icon in (cfg["filters"].get("exclude_icons") or [])


def page_title(page: dict) -> str:
    for prop in (page.get("properties") or {}).values():
        if prop.get("type") == "title":
            return "".join((rt.get("plain_text") or "") for rt in (prop.get("title") or []))
    return ""


def page_icon(page: dict) -> str:
    icon = page.get("icon") or {}
    if icon.get("type") == "emoji":
        return icon.get("emoji") or ""
    return ""


_CN_DIGITS = {
    "零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
    "五": 5, "六": 6, "七": 7, "八": 8, "九": 9,
}


def _cn_number(text: str) -> int | None:
    """中文数字 / 阿拉伯数字 → int（支持 1–999，够讲次用）。"""
    t = (text or "").strip()
    if not t:
        return None
    if t.isdigit():
        return int(t)
    if "十" in t:
        left, _, right = t.partition("十")
        tens = _CN_DIGITS.get(left, 1) if left else 1
        ones = _CN_DIGITS.get(right, 0) if right else 0
        return tens * 10 + ones
    if "百" in t:
        left, _, right = t.partition("百")
        hundreds = _CN_DIGITS.get(left, 1) if left else 1
        rest = _cn_number(right) if right else 0
        return hundreds * 100 + (rest or 0)
    if len(t) == 1:
        return _CN_DIGITS.get(t)
    return None


def is_numbered_article_title(title: str) -> bool:
    """第N讲 / A1 / 1. xxx 这类标题一定是文章；用于省掉「是否有子页」的探测请求。"""
    clean = strip_title_prefix(title)
    return bool(
        re.match(r"^第\s*[一二三四五六七八九十百零两0-9]+\s*讲", clean)
        or re.match(r"^[A-Za-z]\s*\d+", clean)
        or re.match(r"^\d+\s*[.、·]\s*", clean)
    )


def natural_sort_key(title: str, fallback_order: int) -> tuple:
    """课程内自然排序：第 N 讲 → N；A1/B3/F1/G2/T1 → (字母, 数字)；无编号保持原顺序。"""
    clean = strip_title_prefix(title)
    m = re.match(r"^第\s*([一二三四五六七八九十百零两0-9]+)\s*讲", clean)
    if m:
        num = _cn_number(m.group(1))
        if num is not None:
            return (0, 0, num, fallback_order)
    m = re.match(r"^([A-Za-z])\s*(\d+)", clean)
    if m:
        return (0, ord(m.group(1).upper()) - 64, int(m.group(2)), fallback_order)
    m = re.match(r"^(\d+)\s*[.、·]\s*", clean)
    if m:
        return (0, 0, int(m.group(1)), fallback_order)
    return (1, 0, 0, fallback_order)


def _child_page_refs(client: NotionClient, block_id: str, errors: list[str],
                     context: str) -> list[dict]:
    try:
        children = client.list_children(block_id)
    except NotionAuthError:
        raise
    except NotionError as exc:
        errors.append(f"列出子页失败（{context}）：{exc}")
        return []
    refs: list[dict] = []
    for block in children:
        if block.get("type") != "child_page" or not block.get("id"):
            continue
        refs.append({
            "page_id": block["id"],
            "fallback_title": (block.get("child_page") or {}).get("title") or "",
        })
    return refs


def _collect_page_tree(client: NotionClient, refs: list[dict], depth: int, max_depth: int,
                       forced_sections: set[str], cfg: dict, errors: list[str],
                       exclusions: list[dict], sections: list[dict]) -> list[dict]:
    """通用分区规则：有直接 child_page 的页面视为分区，排除自身并展开子页（深度 ≤ max_depth）。"""
    out: list[dict] = []
    for ref in refs:
        pid = ref["page_id"]
        title = ref["fallback_title"]
        reason = title_exclusion_reason(title, cfg)
        if reason:  # 反正要排除的页，不再多打一次子页接口
            exclusions.append({"title": strip_title_prefix(title), "page_id": pid, "reason": reason})
            continue
        child_depth = depth + 1
        sub_refs: list[dict] = []
        is_forced = norm_id(pid) in forced_sections
        # 编号页（第N讲/A1/T1…）按文章处理，不再多打一次子页接口；避免把「有子页的文章」误展开
        if (is_forced or not is_numbered_article_title(title)) and child_depth < max_depth:
            sub_refs = _child_page_refs(client, pid, errors, strip_title_prefix(title))
        is_section = is_forced or bool(sub_refs)
        if is_section:
            sections.append({
                "page_id": pid, "title": strip_title_prefix(title),
                "depth": child_depth, "children": len(sub_refs),
            })
            exclusions.append({
                "title": strip_title_prefix(title), "page_id": pid,
                "reason": f"分区页（自身不是文章，展开 {len(sub_refs)} 个子页）",
            })
            if sub_refs:
                out.extend(_collect_page_tree(client, sub_refs, child_depth, max_depth,
                                              forced_sections, cfg, errors, exclusions, sections))
            continue
        out.append({"page_id": pid, "fallback_title": title, "order": len(out) + 1})
    return out


def discover_real(client: NotionClient, cfg: dict, errors: list[str],
                  exclusions: list[dict], sections: list[dict]) -> list[dict]:
    courses: list[dict] = []
    for course_cfg in sorted(cfg["courses"], key=lambda c: int(c.get("order") or 0)):
        course_id = course_cfg["id"]
        hub = course_cfg["hub"]
        forced = {norm_id(s) for s in (course_cfg.get("sections") or [])}
        hub_refs = _child_page_refs(client, hub, errors, f"课程 {course_id} hub")
        if not hub_refs:
            errors.append(f"课程 {course_id} 没有发现子页")
            courses.append({"slug": course_id, "title": course_cfg.get("title") or course_id,
                            "icon": course_cfg.get("icon") or "",
                            "order": int(course_cfg.get("order") or 0), "articles": []})
            continue
        candidates = _collect_page_tree(client, hub_refs, 0, 2, forced, cfg,
                                        errors, exclusions, sections)
        articles: list[dict] = []
        for cand in candidates:
            pid = cand["page_id"]
            title0 = cand["fallback_title"]
            try:
                page = client.retrieve_page(pid)
            except NotionAuthError:
                raise
            except NotionError as exc:
                errors.append(f"读取页面 {title0} 失败：{exc}")
                continue
            title = strip_title_prefix(page_title(page) or title0)
            icon = page_icon(page)
            reason = title_exclusion_reason(title, cfg)
            if reason:
                exclusions.append({"title": title, "page_id": pid, "reason": reason})
                continue
            articles.append({
                "page_id": pid,
                "title": title,
                "icon": icon,
                "order": int(cand.get("order") or len(articles) + 1),
                "last_edited_time": page.get("last_edited_time") or "",
                "meta": page,
            })
        courses.append({
            "slug": course_id,
            "title": course_cfg.get("title") or course_id,
            "icon": course_cfg.get("icon") or "",
            "order": int(course_cfg.get("order") or 0),
            "articles": articles,
        })
    return courses


def _norm_course_key(value: str) -> str:
    v = re.sub(r"[^0-9a-z]", "", (value or "").lower())
    return v


_KIND_EXCLUDE = {
    "placeholder": "占位页（kind=placeholder）",
    "composite": "综合页（kind=composite）",
    "template": "模板页（kind=template）",
    "section": "分区页（kind=section，自身不是文章）",
    "assignment": "作业页（kind=assignment）",
    "project": "毕业项目（kind=project）",
}


def discover_fixtures(fixtures: Path, cfg: dict, errors: list[str],
                      exclusions: list[dict]) -> list[dict]:
    inv_path = fixtures / "inventory.json"
    if not inv_path.exists():
        raise SystemExit(f"fixture inventory not found: {inv_path}")
    inv = json.loads(inv_path.read_text(encoding="utf-8"))
    inv_courses = inv.get("courses") if isinstance(inv, dict) else None
    if not inv_courses:
        raise SystemExit("fixture inventory.json 缺少 courses")
    by_id: dict[str, dict] = {}
    by_slug: dict[str, dict] = {}
    by_title: dict[str, dict] = {}
    for course in inv_courses:
        cid = str(course.get("id") or "")
        by_id[norm_id(cid)] = course
        by_id[cid] = course
        by_slug[_norm_course_key(cid)] = course
        by_title[_norm_course_key(strip_title_prefix(course.get("title") or ""))] = course
        pid = str(course.get("page_id") or "")
        if pid:
            by_id[norm_id(pid)] = course
            by_id[pid] = course

    courses: list[dict] = []
    for course_cfg in sorted(cfg["courses"], key=lambda c: int(c.get("order") or 0)):
        slug = course_cfg["id"]
        match = (
            by_id.get(norm_id(course_cfg.get("hub") or ""))
            or by_id.get(course_cfg.get("hub") or "")
            or by_slug.get(_norm_course_key(slug))
            or by_title.get(_norm_course_key(strip_title_prefix(course_cfg.get("title") or "")))
        )
        if match is None:
            errors.append(f"fixture 里没有课程 {slug}，跳过")
            continue
        articles = []
        for idx, art in enumerate(match.get("articles") or []):
            pid = str(art.get("id") or art.get("page_id") or "")
            if not pid:
                continue
            title = strip_title_prefix(art.get("title") or "")
            kind = art.get("kind")
            if kind in _KIND_EXCLUDE:
                exclusions.append({"title": title, "page_id": pid, "reason": _KIND_EXCLUDE[kind]})
                continue
            reason = title_exclusion_reason(title, cfg)
            if reason:
                exclusions.append({"title": title, "page_id": pid, "reason": reason})
                continue
            last_edited = art.get("last_edited_time") or ""
            fixture_meta: dict = {}
            pages_dir = fixtures / "pages"
            meta_path = _fixture_file(pages_dir, pid, ".json")
            if meta_path:
                try:
                    fixture_meta = json.loads(meta_path.read_text(encoding="utf-8"))
                except ValueError:
                    fixture_meta = {}
            if fixture_meta.get("last_edited_time"):
                last_edited = fixture_meta["last_edited_time"]
            if fixture_meta.get("title"):
                title = strip_title_prefix(fixture_meta["title"])
                reason = title_exclusion_reason(title, cfg)
                if reason:
                    exclusions.append({"title": title, "page_id": pid, "reason": reason})
                    continue
            articles.append({
                "page_id": pid,
                "title": title,
                "icon": art.get("icon") or "",
                "order": int(art.get("order") or idx + 1),
                "last_edited_time": last_edited,
                "kind": art.get("kind"),
            })
        articles.sort(key=lambda a: a["order"])
        courses.append({
            "slug": slug,
            "title": course_cfg.get("title") or strip_title_prefix(match.get("title") or slug),
            "icon": course_cfg.get("icon") or match.get("icon") or "",
            "order": int(course_cfg.get("order") or 0),
            "articles": articles,
        })
    return courses


# ---------------------------------------------------------------- markdown fetch


def rich_to_md(items: list[dict]) -> str:
    out: list[str] = []
    for item in items or []:
        itype = item.get("type")
        plain = item.get("plain_text") or ""
        if itype == "text":
            text = plain
            annot = item.get("annotations") or {}
            if annot.get("code"):
                text = f"`{text}`"
            if annot.get("bold"):
                text = f"**{text}**"
            if annot.get("italic"):
                text = f"*{text}*"
            if annot.get("strikethrough"):
                text = f"~~{text}~~"
            if annot.get("underline"):
                text = f"<u>{text}</u>"
            href = (item.get("text") or {}).get("link") or {}
            if href.get("url"):
                text = f"[{text}]({href['url']})"
            out.append(text)
        elif itype == "mention":
            url = (item.get("href") or (item.get("mention") or {}).get("url") or "")
            if not url:
                mention = item.get("mention") or {}
                pid = ((mention.get("page") or {}).get("id") or
                       (mention.get("database") or {}).get("id") or "")
                url = f"https://app.notion.com/p/{pid}" if pid else ""
            out.append(f'<mention url="{url}">{plain}</mention>')
        elif itype == "equation":
            expr = (item.get("equation") or {}).get("expression") or plain
            out.append(f"${expr}$")
        else:
            out.append(plain)
    return "".join(out)


def _block_md_lines(client: NotionClient, block: dict, depth: int = 0) -> list[str]:
    btype = block.get("type") or ""
    data = block.get(btype) or {}
    rich = rich_to_md(data.get("rich_text") or [])
    children_md: list[str] = []
    if block.get("has_children"):
        for child in client.list_children(block.get("id") or ""):
            children_md.extend(_block_md_lines(client, child, depth + 1))

    def child_block(pad: str = "") -> list[str]:
        return [pad + line for line in children_md] if children_md else []

    if btype == "paragraph":
        return ([rich] if rich else []) + child_block()
    if btype in ("heading_1", "heading_2", "heading_3", "heading_4"):
        level = int(btype[-1])
        return [("#" * level) + " " + rich]
    if btype == "bulleted_list_item":
        return ["- " + rich] + child_block("  ")
    if btype == "numbered_list_item":
        return ["1. " + rich] + child_block("  ")
    if btype == "to_do":
        mark = "x" if data.get("checked") else " "
        return [f"- [{mark}] {rich}"] + child_block("  ")
    if btype == "quote":
        return [f"<quote>\n{rich}\n\n" + "\n".join(children_md) + "\n</quote>"]
    if btype == "callout":
        icon = (data.get("icon") or {})
        emoji = icon.get("emoji") if icon.get("type") == "emoji" else ""
        return [f'<callout icon="{emoji}">\n{rich}\n\n' + "\n".join(children_md) + "\n</callout>"]
    if btype == "code":
        lang = data.get("language") or ""
        code = "".join((rt.get("plain_text") or "") for rt in (data.get("rich_text") or []))
        return [f"```{lang}\n{code}\n```"]
    if btype == "divider":
        return ["---"]
    if btype == "image":
        media = data.get("file") or data.get("external") or {}
        url = media.get("url") or ""
        cap = rich_to_md(data.get("caption") or [])
        return [f"![{cap}]({url})"]
    if btype in ("bookmark", "embed", "video", "audio", "pdf", "file"):
        url = (data.get("file") or data.get("external") or {}).get("url") or data.get("url") or ""
        return [f'<bookmark source="{url}"/>'] if url else []
    if btype == "table":
        rows: list[str] = []
        try:
            for row in client.list_children(block.get("id") or ""):
                cells = [rich_to_md(c.get("rich_text") or []) for c in
                         (row.get("table_row") or {}).get("cells") or []]
                rows.append("| " + " | ".join(cells) + " |")
        except NotionError:
            pass
        return rows
    if btype == "equation":
        return [f"<equation>{(data.get('expression') or '')}</equation>"]
    if btype == "child_page":
        return [f'<page url="https://app.notion.com/p/{block.get("id")}">{data.get("title") or ""}</page>']
    if btype == "child_database":
        return []
    if btype in ("column_list", "column", "synced_block", "template"):
        return children_md
    if btype == "table_of_contents":
        return ["<table-of-contents />"]
    # 兜底：有 rich_text 当段落，有子块就展开
    fallback = [rich] if rich else []
    return fallback + child_block()


def fetch_markdown(client: NotionClient, page_id: str) -> tuple[str, str]:
    """返回 (markdown, 来源)。markdown 接口失败时回退 block children 递归。"""
    try:
        resp = client.page_markdown(page_id)
    except NotionAuthError:
        raise
    except NotionError as exc:
        log(f"markdown 接口失败（{exc}），回退 block children", err=True)
        return blocks_to_markdown(client, page_id), "blocks"
    md = resp.get("markdown") or ""
    if resp.get("truncated") and resp.get("unknown_block_ids"):
        extra: list[str] = []
        for block_id in (resp.get("unknown_block_ids") or [])[:20]:
            try:
                sub = client.page_markdown(block_id)
                part = sub.get("markdown") or ""
                if part:
                    extra.append(part)
            except NotionAuthError:
                raise
            except NotionError:
                continue
        if extra:
            md = md + "\n\n" + "\n\n".join(extra)
    return md, "markdown"


def blocks_to_markdown(client: NotionClient, page_id: str) -> str:
    lines: list[str] = []
    for block in client.list_children(page_id):
        lines.extend(_block_md_lines(client, block))
    return "\n\n".join(lines)


# ---------------------------------------------------------------- media


def image_to_webp(data: bytes, cfg: dict) -> dict | None:
    out_cfg = cfg["output"]
    max_edge = int(out_cfg.get("media_max_edge") or 1600)
    quality = int(out_cfg.get("media_quality") or 82)
    try:
        img = Image.open(io.BytesIO(data))
        img = ImageOps.exif_transpose(img)
        img.load()
    except Exception:
        return None
    try:
        if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
            img = img.convert("RGBA")
        elif img.mode != "RGB":
            img = img.convert("RGB")
        w, h = img.size
        if max(w, h) > max_edge:
            scale = max_edge / float(max(w, h))
            img = img.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
            w, h = img.size
        buf = io.BytesIO()
        img.save(buf, format="WEBP", quality=quality, method=6)
        webp = buf.getvalue()
        return {"sha": sha256_bytes(webp), "ext": "webp", "w": w, "h": h, "bytes": webp}
    except Exception:
        return None


def resolve_image_path(fixtures: Path, url: str) -> Path | None:
    raw = url.strip()
    if raw.startswith("file://"):
        raw = raw[7:]
    if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", raw):
        return None
    path = Path(raw)
    if not path.is_absolute():
        path = fixtures / raw
    try:
        path = path.resolve()
        path.relative_to(fixtures.resolve())
    except (ValueError, OSError):
        return None
    return path if path.is_file() else None


# ---------------------------------------------------------------- mermaid


def render_mermaids(items: list[dict], cfg: dict, work_dir: Path) -> dict[str, str]:
    """items: [{id, code}]；返回 {id: svg}。失败的 id 不在结果里（调用方 fallback）。"""
    if not items:
        return {}
    cache_dir = work_dir / "mermaid-cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    pending: list[dict] = []
    svgs: dict[str, str] = {}
    for item in items:
        cache_file = cache_dir / f"{item['id']}.svg"
        if cache_file.exists() and cache_file.stat().st_size > 0:
            svgs[item["id"]] = cache_file.read_text(encoding="utf-8")
        else:
            pending.append(item)
    if not pending:
        return svgs

    input_path = work_dir / "mermaid-input.json"
    output_dir = work_dir / "mermaid-out"
    input_path.write_text(json.dumps(pending, ensure_ascii=False), encoding="utf-8")
    mcfg = cfg["mermaid"]
    font = mcfg.get("font") or str(FONT_DEFAULT)
    font_path = (HERE / font).resolve() if not Path(font).is_absolute() else Path(font)
    node = shutil.which("node")
    if not node:
        log("找不到 node，mermaid 全部回退源码", err=True)
        return svgs
    cmd = [
        node, str(HERE / "render_mermaid.mjs"),
        "--input", str(input_path),
        "--output-dir", str(output_dir),
        "--chrome", str(mcfg.get("chrome") or CHROME_DEFAULT),
        "--font", str(font_path),
        "--font-size", str(int(mcfg.get("font_size") or 24)),
        "--theme", str(mcfg.get("theme") or "default"),
        "--max-parallel", str(int(mcfg.get("max_parallel") or 4)),
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=900, cwd=str(HERE))
    except subprocess.TimeoutExpired:
        log("mermaid 渲染超时，全部回退源码", err=True)
        return svgs
    payload = None
    for line in reversed((proc.stdout or "").splitlines()):
        line = line.strip()
        if line.startswith("{") and line.endswith("}"):
            try:
                payload = json.loads(line)
                break
            except ValueError:
                continue
    if not payload:
        tail = (proc.stderr or proc.stdout or "")[-400:]
        log(f"mermaid 渲染失败（退出码 {proc.returncode}）：{tail}", err=True)
        return svgs
    for entry in payload.get("ok") or []:
        path = Path(entry.get("path") or "")
        if path.is_file():
            svg = path.read_text(encoding="utf-8")
            svgs[entry.get("id")] = svg
            (cache_dir / f"{entry.get('id')}.svg").write_text(svg, encoding="utf-8")
    for entry in payload.get("errors") or []:
        log(f"mermaid 渲染失败 {entry.get('id')}: {entry.get('error')}", err=True)
    return svgs


# ---------------------------------------------------------------- build help


def prev_index(dist: Path) -> dict | None:
    path = dist / "index.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return None


def index_articles(index: dict) -> dict[str, dict]:
    """flat article_id → entry（含 course/path）。"""
    out: dict[str, dict] = {}
    for course in (index or {}).get("courses") or []:
        for art in course.get("articles") or []:
            out[art.get("id")] = art
    return out


def link_prev_release(dist: Path, prev_rel: str | None, new_dir: Path, entry: dict) -> str | None:
    """把旧 release 里的文章 HTML 硬链接/复制进新 release，返回相对路径。"""
    if not prev_rel:
        return None
    # entry.path 形如 releases/<rel>/a/<course>/<id>.html
    rel = entry.get("path") or ""
    old = dist / rel
    if not old.is_file():
        return None
    course = old.parent.name
    target = new_dir / "a" / course / old.name
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        if target.exists():
            target.unlink()
        os.link(old, target)
    except OSError:
        shutil.copy2(old, target)
    return f"releases/{new_dir.name}/a/{course}/{old.name}"


def atomic_write(path: Path, text: str) -> None:
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def load_state(path: Path) -> dict:
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            return {}
    return {}


def save_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write(path, json.dumps(data, ensure_ascii=False, indent=2) + "\n")


# ---------------------------------------------------------------- main run


def build(args: argparse.Namespace) -> int:
    cfg_path = Path(args.config).resolve() if args.config else DEFAULT_CONFIG
    cfg = load_config(cfg_path)
    out_cfg = cfg["output"]
    dist = Path(args.dist).resolve() if args.dist else (HERE / (out_cfg.get("dist") or "dist"))
    work_dir = HERE / "state"
    work_dir.mkdir(parents=True, exist_ok=True)
    fixtures = Path(args.from_fixtures).resolve() if args.from_fixtures else None
    dry_run = bool(args.dry_run)
    source = "fixtures" if fixtures else "notion"

    started = now_local()
    errors: list[str] = []
    skipped: list[str] = []
    exclusions: list[dict] = []
    sections_found: list[dict] = []
    api_calls = 0

    # 锁：防止两个同步进程同时写 dist
    lock_file = work_dir / (".lock-fixtures" if fixtures else ".lock")
    lock_handle = lock_file.open("w")
    try:
        fcntl.flock(lock_handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        log("已有同步进程在跑，退出", err=True)
        return 75

    state_path = HERE / (out_cfg.get("state") or "state/state.json")
    if fixtures:
        state_path = state_path.with_name("state-fixtures.json")
    state = load_state(state_path)
    state_pages: dict = state.get("pages") or {}

    try:
        if fixtures:
            courses = discover_fixtures(fixtures, cfg, errors, exclusions)
            client = None
        else:
            token = os.environ.get("NOTION_TOKEN") or ""
            if not token:
                log("缺少 NOTION_TOKEN（真实模式）；fixture 模式请加 --from-fixtures", err=True)
                return 2
            client = NotionClient(cfg, token)
            courses = discover_real(client, cfg, errors, exclusions, sections_found)

        # 展平、应用 --limit
        flat: list[tuple[dict, dict]] = []
        for course in courses:
            for art in course["articles"]:
                flat.append((course, art))
        if args.limit and args.limit > 0:
            flat = flat[: args.limit]
            keep = {id(a) for _, a in flat}
            for course in courses:
                course["articles"] = [a for a in course["articles"] if id(a) in keep]

        p_index = prev_index(dist)
        p_articles = index_articles(p_index) if p_index else {}
        p_release = (p_index or {}).get("release")

        release = release_id(started)
        if p_release == release:
            time.sleep(1)
            release = release_id(now_local())
        new_dir = dist / "releases" / release
        (new_dir / "a").mkdir(parents=True, exist_ok=True)

        changed_articles: list[dict] = []   # 需要重建的文章（含 blocks/assets）
        reused_articles: list[dict] = []    # 复用上一版
        failed_articles: list[dict] = []
        pending_skipped: list[str] = []

        # 先做增量判定 + 取正文
        for course, art in flat:
            pid = art["page_id"]
            slug = article_slug(pid)
            art["slug"] = slug
            art["course"] = course["slug"]
            prev_state = state_pages.get(pid) or {}
            prev_entry = p_articles.get(slug)
            unchanged = (
                not args.full
                and prev_entry
                and prev_state.get("last_edited_time")
                and prev_state.get("last_edited_time") == art.get("last_edited_time")
                and (dist / (prev_entry.get("path") or "")).is_file()
            )
            if unchanged:
                reused_articles.append({"course": course, "article": art, "prev_entry": prev_entry,
                                        "prev_state": prev_state})
                continue
            try:
                if fixtures:
                    markdown, meta = load_fixture_page(fixtures, art)
                    if meta:
                        art["last_edited_time"] = meta.get("last_edited_time") or art.get("last_edited_time")
                        art["title"] = strip_title_prefix(meta.get("title") or art["title"])
                        art["icon"] = art.get("icon") or meta.get("icon") or ""
                else:
                    markdown, how = fetch_markdown(client, pid)
                    art["fetch"] = how
            except NotionAuthError:
                raise
            except (NotionError, OSError) as exc:
                errors.append(f"{art['title']}：取正文失败 {exc}")
                if prev_entry and (dist / (prev_entry.get("path") or "")).is_file():
                    failed_articles.append({"course": course, "article": art, "prev_entry": prev_entry})
                continue
            blocks = parse_markdown(markdown)
            blocks = clean_blocks(blocks, art["title"], cfg["clean"])
            blocks = attach_captions(blocks)
            plain_len = len(re.sub(r"\s+", "", " ".join(mdparse._block_plain(b) for b in blocks)))
            min_chars = int(cfg["filters"].get("min_body_chars") or 200)
            pending_chars = int(cfg["filters"].get("pending_body_chars") or 1200)
            skip_reason = ""
            if plain_len < min_chars:
                skip_reason = f"正文过短（{plain_len} 字 < {min_chars}）"
            elif (art.get("icon") in (cfg["filters"].get("exclude_icons") or [])
                  and plain_len < pending_chars):
                # 旧 ⏳ 图标只在正文短时才算占位；第十二讲这种已写完的长文要保留
                skip_reason = f"icon {art['icon']} 且正文 {plain_len} 字 < {pending_chars}"
            else:
                markers = cfg["filters"].get("pending_markers") or []
                head = markdown[:2500]
                if plain_len < pending_chars and any(marker in head for marker in markers):
                    skip_reason = f"正文含占位标记且正文 {plain_len} 字 < {pending_chars}"
            if skip_reason:
                pending_skipped.append(f"{art['title']}（{skip_reason}）")
                exclusions.append({"title": art["title"], "page_id": pid, "reason": skip_reason})
                continue
            art["markdown"] = markdown
            art["blocks"] = blocks
            art["markdown_sha"] = sha256_text(markdown)
            changed_articles.append({"course": course, "article": art})

        # 只保留会进 index 的文章：待发布/占位页不参与链接图，避免死链
        included_pids = {
            item["article"]["page_id"] for item in (changed_articles + reused_articles + failed_articles)
        }
        for course in courses:
            course["articles"] = [a for a in course["articles"] if a["page_id"] in included_pids]
            # 课程内自然排序：第N讲→N、A1→(字母,数字)；无编号保持 Notion 原顺序
            course["articles"].sort(key=lambda a: natural_sort_key(a["title"], int(a.get("order") or 0)))
            for idx, art in enumerate(course["articles"], start=1):
                art["order"] = idx
        linkmap = build_linkmap(courses)

        # 素材：图片（下载/转 WebP）
        media: dict[str, dict] = {}
        media_bytes = 0
        image_jobs: list[tuple[dict, Block]] = []
        for item in changed_articles:
            for block in walk_blocks(item["article"]["blocks"]):
                if block.type == "image" and block.url:
                    image_jobs.append((item["article"], block))

        def fetch_image(job: tuple[dict, Block]) -> tuple[Block, dict | None, str]:
            art, block = job
            try:
                if fixtures:
                    path = resolve_image_path(fixtures, block.url)
                    if not path:
                        return block, None, "fixture 图片不存在"
                    data = path.read_bytes()
                else:
                    if block.url.startswith("notion-file-block:"):
                        return block, None, "notion-file-block:// 无法下载（REST 应给 signed https）"
                    data = client.download(block.url)  # type: ignore[union-attr]
                result = image_to_webp(data, cfg)
                if not result:
                    return block, None, "图片解码失败"
                return block, result, ""
            except (NotionError, OSError) as exc:
                return block, None, str(exc)

        if image_jobs:
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                for block, result, err in pool.map(fetch_image, image_jobs):
                    if result:
                        block.media = {"sha": result["sha"], "ext": result["ext"],
                                       "w": result["w"], "h": result["h"]}
                        media.setdefault(result["sha"], result)
                    elif err:
                        errors.append(f"图片失败：{err}")
        for item in media.values():
            media_bytes += len(item["bytes"])

        # 素材：mermaid
        mm_items: dict[str, str] = {}
        for item in changed_articles:
            for block in walk_blocks(item["article"]["blocks"]):
                if block.type == "mermaid" and block.code.strip():
                    mm_items[mdparse.media_key(block.code)] = block.code
        mm_svgs = render_mermaids(
            [{"id": key, "code": code, "dom_id": "kbmm" + key} for key, code in mm_items.items()],
            cfg, work_dir,
        )
        mermaid_ok = 0
        mermaid_failed = 0
        for item in changed_articles:
            for block in walk_blocks(item["article"]["blocks"]):
                if block.type == "mermaid":
                    svg = mm_svgs.get(mdparse.media_key(block.code))
                    if svg:
                        block.svg = svg
                        mermaid_ok += 1
                    else:
                        mermaid_failed += 1

        if client is not None:
            api_calls = client.calls

        # 构建新 release + index
        index_courses: list[dict] = []
        for course in courses:
            entries: list[dict] = []
            for art in course["articles"]:
                if not art.get("slug"):
                    art["slug"] = article_slug(art["page_id"])
                    art["course"] = course["slug"]
            for art in course["articles"]:
                slug = art["slug"]
                changed = next((c for c in changed_articles
                                if c["article"]["page_id"] == art["page_id"]), None)
                reused = next((r for r in reused_articles
                               if r["article"]["page_id"] == art["page_id"]), None)
                failed = next((f for f in failed_articles
                               if f["article"]["page_id"] == art["page_id"]), None)
                if failed:
                    prev = failed["prev_entry"]
                    entry = dict(prev)  # 保留旧内容与旧 path
                    entry["order"] = int(art.get("order") or 0)
                    old_file = dist / (entry.get("path") or "")
                    if old_file.is_file():
                        entry["sha"] = html_sha(old_file.read_bytes())
                    entries.append(entry)
                    continue
                if reused:
                    prev = reused["prev_entry"]
                    path_rel = link_prev_release(dist, p_release, new_dir, prev)
                    if not path_rel:
                        errors.append(f"{art['title']}：旧 release 文件丢失，跳过")
                        continue
                    target = dist / path_rel
                    entry = dict(prev)
                    entry["path"] = path_rel
                    entry["order"] = int(art.get("order") or 0)
                    entry["sha"] = html_sha(target.read_bytes())
                    entries.append(entry)
                    continue
                if not changed:
                    continue  # pending skipped
                blocks = changed["article"]["blocks"]
                updated = (parse_iso(art.get("last_edited_time") or "") or now_local()).astimezone()
                html, stats = render_article(
                    slug, art["title"], course["title"],
                    updated.strftime("%Y-%m-%d"), blocks, linkmap,
                )
                target = new_dir / "a" / course["slug"] / f"{slug}.html"
                target.parent.mkdir(parents=True, exist_ok=True)
                html_bytes = html.encode("utf-8")
                target.write_bytes(html_bytes)
                words = int(stats.get("words") or 0)
                entries.append({
                    "id": slug,
                    "title": art["title"],
                    "order": int(art.get("order") or 0),
                    "updated": art.get("last_edited_time") or "",
                    "sha": html_sha(html_bytes),
                    "words": words,
                    "read_min": max(1, math.ceil(words / 450)) if words else 0,
                    "path": f"releases/{release}/a/{course['slug']}/{slug}.html",
                    # 总数（含渲染失败后回退为源码的图）——verify 用 svg + fallback 对齐
                    "mermaid": int(stats.get("mermaid") or 0) + int(stats.get("mermaid_failed") or 0),
                    "images": stats.get("images") or [],
                })
            entries.sort(key=lambda e: (int(e.get("order") or 0), e.get("title") or ""))
            if entries:
                index_courses.append({
                    "id": course["slug"],
                    "title": course["title"],
                    "icon": course["icon"],
                    "order": int(course["order"] or 0),
                    "articles": entries,
                })
        index_courses.sort(key=lambda c: int(c.get("order") or 0))
        articles_total = sum(len(c["articles"]) for c in index_courses)

        generated_at = now_local().isoformat(timespec="seconds")
        index = {
            "fmt": 1,
            "release": release,
            "generated_at": generated_at,
            "articles_total": articles_total,
            "courses": index_courses,
        }
        status = {
            "generated_at": generated_at,
            "release": release,
            "articles": articles_total,
            "ok": not errors,
            "source": source,
            "media": len(media),
            "media_bytes": media_bytes,
            "mermaid": {"ok": mermaid_ok, "failed": mermaid_failed},
        }

        # 写 media（内容寻址，已存在则跳过）
        media_dir = dist / "media"
        media_dir.mkdir(parents=True, exist_ok=True)
        for sha, item in media.items():
            target = media_dir / f"{sha}.webp"
            if not target.exists() or target.stat().st_size != len(item["bytes"]):
                atomic_write_bytes(target, item["bytes"])

        # 清理空 release（如果没有任何文章）
        scheduled_release = new_dir
        if articles_total == 0:
            shutil.rmtree(new_dir, ignore_errors=True)

        # index / status 最后原子写
        dist.mkdir(parents=True, exist_ok=True)
        atomic_write(dist / "index.json", json.dumps(index, ensure_ascii=False, indent=2) + "\n")
        atomic_write(dist / "status.json", json.dumps(status, ensure_ascii=False, indent=2) + "\n")

        # 清理旧 release（保留 keep_releases，且保留 index 引用到的）
        keep_n = int(out_cfg.get("keep_releases") or 3)
        prune_releases(dist, release, keep_n)

        # state（dry-run 不写，便于反复跑）
        if not dry_run:
            pages_state: dict[str, dict] = {}
            for course in index_courses:
                for entry in course["articles"]:
                    pages_state[entry["id"]] = {
                        "last_edited_time": entry.get("updated") or "",
                        "release": release,
                    }
            # 用 page_id 做 key 才能对上增量判定
            page_map = {a["slug"]: a["page_id"] for _, a in flat}
            pages_by_pid = {page_map.get(slug, slug): v for slug, v in pages_state.items()}
            save_json(state_path, {"version": 1, "source": source,
                                   "last_release": release, "pages": pages_by_pid})

        finished = now_local()
        elapsed = (finished - started).total_seconds()
        last_run = {
            "started_at": started.isoformat(timespec="seconds"),
            "finished_at": finished.isoformat(timespec="seconds"),
            "ok": not errors,
            "source": source,
            "release": release,
            "articles": articles_total,
            "changed": len(changed_articles),
            "reused": len(reused_articles),
            "kept_old": len(failed_articles),
            "skipped_pending": pending_skipped,
            "excluded": exclusions,
            "sections": sections_found,
            "media": len(media),
            "media_bytes": media_bytes,
            "mermaid_ok": mermaid_ok,
            "mermaid_failed": mermaid_failed,
            "api_calls": api_calls,
            "elapsed_sec": round(elapsed, 1),
            "errors": errors,
        }
        if not dry_run:
            save_json(HERE / (out_cfg.get("last_run") or "state/last-run.json"), last_run)

        # 发布（默认关闭，打印打码后的 dry-run 命令）
        do_publish = bool(args.publish) and bool(cfg["publish"].get("enabled")) and not dry_run
        publish_commands = build_publish_commands(cfg, dist, release, mask=not do_publish)
        if do_publish:
            remote_dir = os.environ.get(cfg["publish"].get("remote_dir_env") or "REMOTE_DIR") or ""
            if not remote_dir:
                log("--publish 需要 REMOTE_DIR（含 secret 的远端目录），跳过发布", err=True)
                errors.append("publish 缺少 REMOTE_DIR")
            else:
                execute_publish(publish_commands, remote_dir)
        else:
            for cmd in publish_commands:
                print(f"# dry-run publish: {cmd}")

        # 摘要
        log(f"release={release} articles={articles_total} changed={len(changed_articles)} "
            f"reused={len(reused_articles)} media={len(media)} ({human_bytes(media_bytes)}) "
            f"mermaid={mermaid_ok}ok/{mermaid_failed}fail api={api_calls} "
            f"elapsed={elapsed:.1f}s")
        if sections_found:
            log(f"分区页展开 {len(sections_found)} 个：" +
                "；".join(f"{s['title']}（{s['children']} 子页）" for s in sections_found))
        if exclusions:
            log(f"排除 {len(exclusions)} 个页面：")
            for item in exclusions:
                log(f"  - {item['title']}（{item['reason']}）")
        if errors:
            for err in errors:
                log(f"ERROR {err}", err=True)
            log(f"完成但有 {len(errors)} 个错误（旧内容保留）", err=True)
            return 1
        log("OK")
        return 0
    except NotionAuthError as exc:
        log(f"鉴权失败：{exc}（保留旧版，退出）", err=True)
        return 3
    except Exception as exc:  # noqa: BLE001 - 顶层兜底，打印栈便于排查
        log(f"同步失败：{exc}", err=True)
        traceback.print_exc(file=sys.stderr)
        return 1
    finally:
        lock_handle.close()


# ---------------------------------------------------------------- helpers


def walk_blocks(blocks: list[Block]):
    for block in blocks:
        yield block
        yield from walk_blocks(block.children or [])
        if block.type == "list":
            for item in block.items:
                yield from walk_blocks(item.get("children") or [])


def build_linkmap(courses: list[dict]) -> dict[str, dict]:
    linkmap: dict[str, dict] = {}
    for course in courses:
        for art in course["articles"]:
            linkmap[norm_id(art["page_id"])] = {"course": course["slug"],
                                                "article": art["slug"],
                                                "title": art["title"]}
    return linkmap


def atomic_write_bytes(path: Path, data: bytes) -> None:
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def prune_releases(dist: Path, current: str, keep_n: int) -> None:
    rel_dir = dist / "releases"
    if not rel_dir.is_dir():
        return
    referenced: set[str] = set()
    idx_path = dist / "index.json"
    if idx_path.exists():
        try:
            idx = json.loads(idx_path.read_text(encoding="utf-8"))
            for course in idx.get("courses") or []:
                for art in course.get("articles") or []:
                    m = re.search(r"releases/([0-9T]+)/", art.get("path") or "")
                    if m:
                        referenced.add(m.group(1))
        except (ValueError, OSError):
            pass
    releases = sorted([p.name for p in rel_dir.iterdir() if p.is_dir()])
    keep = set(releases[-keep_n:]) | {current} | referenced
    for name in releases:
        if name not in keep:
            shutil.rmtree(rel_dir / name, ignore_errors=True)


def load_fixture_page(fixtures: Path, art: dict) -> tuple[str, dict]:
    pid = art["page_id"]
    pages = fixtures / "pages"
    md_path = _fixture_file(pages, pid, ".md")
    if not md_path:
        raise OSError(f"fixture markdown not found for {pid}")
    markdown = md_path.read_text(encoding="utf-8")
    meta: dict = {}
    json_path = _fixture_file(pages, pid, ".json")
    if json_path:
        try:
            meta = json.loads(json_path.read_text(encoding="utf-8"))
        except ValueError:
            meta = {}
    if not meta.get("last_edited_time"):
        meta["last_edited_time"] = dt.datetime.fromtimestamp(
            md_path.stat().st_mtime, tz=dt.timezone.utc
        ).isoformat()
    return markdown, meta


def _fixture_file(base: Path, pid: str, suffix: str) -> Path | None:
    candidates = [pid, pid.replace("-", ""), norm_uuid(pid)]
    for cand in candidates:
        path = base / f"{cand}{suffix}"
        if path.is_file():
            return path
    key = norm_id(pid)[:16] or re.sub(r"[^0-9a-z]", "", pid.lower())[:16]
    if key:
        for path in sorted(base.glob(f"*{suffix}")):
            if norm_id(path.stem).startswith(key):
                return path
    return None


# ---------------------------------------------------------------- publish


def build_publish_commands(cfg: dict, dist: Path, release: str, *, mask: bool = True) -> list[str]:
    host = os.environ.get(cfg["publish"].get("host_env") or "") or cfg["publish"].get("host") or "ubuntu@43.131.233.151"
    remote_dir = os.environ.get(cfg["publish"].get("remote_dir_env") or "REMOTE_DIR") or ""
    # dry-run 默认把含 secret 的远端目录打码，避免日志泄露
    base = "<REMOTE_DIR>" if (mask or not remote_dir) else remote_dir
    return [
        # 远端目录首次发布时不存在；用 sudo install -d 建好（和现有的 publish_update.sh 同款权限）
        f'ssh {host} "sudo install -d -o ubuntu -g ubuntu -m 0755 {base} {base}/media {base}/releases"',
        f"rsync -az --ignore-existing {dist}/media/ {host}:{base}/media/",
        f"rsync -az {dist}/releases/{release}/ {host}:{base}/releases/{release}/",
        f"scp -q {dist}/index.json {host}:{base}/.index.json.tmp",
        f"ssh {host} \"mv {base}/.index.json.tmp {base}/index.json\"",
        f"scp -q {dist}/status.json {host}:{base}/.status.json.tmp",
        f"ssh {host} \"mv {base}/.status.json.tmp {base}/status.json\"",
    ]


def execute_publish(commands: list[str], remote_dir: str) -> None:
    for cmd in commands:
        resolved = cmd.replace("<REMOTE_DIR>", remote_dir)
        # 日志里对 secret 路径打码，避免落盘泄露
        log(f"publish: {resolved.replace(remote_dir, '<REMOTE_DIR>')}")
        proc = subprocess.run(resolved, shell=True, capture_output=True, text=True)
        if proc.returncode != 0:
            masked = resolved.replace(remote_dir, "<REMOTE_DIR>")
            raise RuntimeError(f"publish 命令失败：{masked}\n{proc.stderr[-300:]}")


# ---------------------------------------------------------------- cli


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Notion 知识库 → 书边译课程板块同步")
    parser.add_argument("--from-fixtures", metavar="DIR", help="fixture 模式：读取离线导出目录")
    parser.add_argument("--full", action="store_true", help="忽略增量 state，全部重建")
    parser.add_argument("--dry-run", action="store_true", help="只构建 dist，不写 state、不发布")
    parser.add_argument("--limit", type=int, default=0, help="只处理前 N 篇（开发用）")
    parser.add_argument("--publish", action="store_true", help="构建后 rsync 到远端（默认关闭）")
    parser.add_argument("--config", help="配置文件路径（默认 ./config.yaml）")
    parser.add_argument("--dist", help="产物目录（默认 ./dist）")
    args = parser.parse_args(argv)
    return build(args)


if __name__ == "__main__":
    sys.exit(main())
