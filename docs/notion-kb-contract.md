# 课程板块数据契约 v1

2026-11-07 · 服务端同步产物 ⇄ 书边译 App 的接口约定。改字段先改 `fmt` 版本号并同时改两端。

## 1. 服务端产物布局

```
<base>/                          # https://update.lemonation.cloud/shubian-kb/<secret>
  status.json                    # 探活：{generated_at, release, articles, ok}
  index.json                     # 目录/元数据（no-store）
  media/<sha256>.<ext>           # 图片等媒体，内容寻址，immutable
  releases/<release>/a/<course>/<article>.html   # 文章正文片段，immutable
```

- `<release>`：`YYYYMMDDTHHMMSS`，每轮同步一个，保留最近 3 个。
- 媒体按字节 sha256 命名，全局去重；`ext` 为 `webp`（图片）。
- `index.json` 最后原子替换；失败时保持上一版不变。

## 2. index.json

```json
{
  "fmt": 1,
  "release": "20261107T153000",
  "generated_at": "2026-11-07T15:30:12+08:00",
  "articles_total": 68,
  "courses": [
    {
      "id": "cs2680",
      "title": "CS2680 · 现代 AI 系统",
      "icon": "🎓",
      "order": 1,
      "articles": [
        {
          "id": "l1",
          "title": "第一讲 · 课程概览",
          "order": 1,
          "updated": "2026-11-06T18:42:00.000Z",
          "sha": "9f2c1a4b7d0e3f56",
          "words": 11000,
          "read_min": 8,
          "path": "releases/20261107T153000/a/cs2680/l1.html",
          "mermaid": 4,
          "images": [
            {"sha": "9f2c…", "ext": "webp", "w": 1400, "h": 900}
          ]
        }
      ]
    }
  ]
}
```

约定：
- `course.id` / `article.id` 只用 `[a-z0-9-]`，由同步侧生成且**跨轮稳定**（Notion page_id 派生，例如去掉连字符取前 12 位）。
- `words` 为正文中文字符数近似值；`read_min = ceil(words/450)` 仅供参考。
- `sha` = 该篇最终 HTML 字节的 sha256 前 16 位小写 hex；App 用它判断文章是否需要重新下载（`updated` 只用于「新」标记，不能反映同步侧重烘焙）。
- `images[].sha` 与 `media/<sha>.<ext>` 对应；App 只下载列表里列出的媒体。
- `icon` 可为空字符串。

## 3. 文章 HTML（正文片段，不是完整页面）

- 输出**body 片段**（无 `<!doctype>/<html>/<head>`），由一个 `<article class="kb-art" data-id="…">` 包裹。
- 结构约定：
  ```html
  <article class="kb-art" data-id="l1">
    <h1>第一讲 · 课程概览</h1>
    <p class="kb-byline">CS2680 · 更新于 2026-11-06</p>
    <h2 id="kb-s1">一、这门课到底在讲什么</h2>
    <p>…</p>
    <figure><img src="/kb/i/<sha>.webp" width="1400" height="900" loading="lazy" alt=""><figcaption>图注：…</figcaption></figure>
    <figure class="kb-mm"><svg …>…</svg><figcaption>图1：…</figcaption></figure>
    <div class="kb-tw"><table>…</table></div>
    <pre><code class="language-python">…</code></pre>
    <blockquote>…</blockquote>
    <p><a href="/kb/a/cs2680/l2.html" data-kb-article="l2">第二讲</a></p>
    <p><a href="https://…" data-external="1">外链</a></p>
  </article>
  ```
- 必须：
  - `h2/h3` 带稳定 `id`（TOC 用），不要依赖 `h1`。
  - 图片一律 `/kb/i/<sha>.<ext>`，必须带 `width/height`、`loading="lazy"`、`alt`（可空）。**不得出现 Notion 域名、签名 URL、`notion-file-block://`。**
  - mermaid 一律同步侧渲染为**内联 SVG**（`<figure class="kb-mm">`）；渲染失败时保留 `<pre><code class="language-mermaid">源码</code></pre>`。
  - 表格外包 `<div class="kb-tw">`（App 负责横向滚动）。
  - 内部文章链接用 `/kb/a/<course>/<article>.html` + `data-kb-article`；外链加 `data-external="1"`。
  - 不含 `<script>`、`<iframe>`、`on*` 事件属性、`<style>`（mermaid 自带 `<style>` 除外）。
  - 不出现 `导语｜`段、页眉署名、「状态」段、结尾「第 N 讲完。」、目录占位块。
- 允许：h1/h2/h3/h4、p、ul/ol/li、table、figure/figcaption、img、pre/code、blockquote、strong/em/code/a、hr、callout 转成 `<aside class="kb-note">`。

## 4. App 本地缓存

```
filesDir/kb/index.json
filesDir/kb/a/<course>/<article>.html
filesDir/kb/i/<sha>.<ext>
```

- App 从 `{KB_BASE}/index.json` 拉目录；`path` 相对 `KB_BASE` 解析。
- 文章下载后存到 `/kb/a/<course>/<article>.html`，并把内部链接保持为同一路径规则；`/kb/` 由 `WebActivity.serve()` 从 `filesDir/kb/` 读取，`Cache-Control: no-store`。
- 图片下载后存 `filesDir/kb/i/<sha>.<ext>`。
- 进度/已读：SharedPreferences `kv` 的 `kbprog`（`{articleId:{y,pct,at}}`）与 `kbseen`（`{articleId:updated}`）。
- `build.gradle` 注入 `KB_BASE`（含 secret 路径）与可选 `KB_TOKEN`；两者来自 `local.properties`，不入 Git。

## 5. 同步端 fixture 模式（无 token 开发用）

`tools/notion-sync/sync.py --from-fixtures <dir>` 使用：

```
<dir>/inventory.json          # {courses:[{id,title,icon,order,articles:[{id,title,parent_page_id,last_edited_time,kind}]}]}
<dir>/pages/<page_id>.md      # Notion-flavored markdown（图片写成 ![alt](media/<name>.png)）
<dir>/pages/<page_id>.json    # {id,title,url,last_edited_time}
<dir>/media/<name>.png        # 已下载的图片
```

fixture 模式跳过 Notion API 和图片下载，但清洗、mermaid 渲染、HTML 生成、index 生成、产物布局必须与真实模式完全一致。
