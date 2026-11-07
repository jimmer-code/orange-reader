# notion-sync · Notion 知识库 → 书边译「课程」板块

把 Notion 知识库的 4 门课同步成静态内容包（正文 HTML + `index.json` + WebP 图片 + 内联 mermaid SVG），
产物布局/字段严格按 `docs/notion-kb-contract.md` v1（`fmt: 1`）。只读 Notion，不写回。

## 目录

```
config.yaml          课程 hub、过滤/清洗规则、输出与发布参数
sync.py              主流程：发现 → 增量 → 取 Markdown → 清洗 → 资产 → 构建 → 发布
mdparse.py           Notion-flavored Markdown → 清洗后的正文 HTML（R1–R20 规则）
render_mermaid.mjs   puppeteer-core + 本机 Chrome + Fusion Pixel 批量渲染 SVG
verify.py            校验 dist 是否符合契约（PASS/FAIL）
run.sh               加锁 + source token 文件 + 日志 + 调 sync.py
pyproject.toml       Python 依赖（requests / Pillow / PyYAML），uv 或现有 venv 均可
package.json         node 依赖（mermaid / puppeteer-core），只给 mermaid 预渲染用
```

产物（默认 `dist/`）：

```
index.json                                  目录/元数据，最后原子替换
status.json                                 探活 {generated_at, release, articles, ok}
media/<sha256>.webp                         内容寻址图片，immutable
releases/<YYYYMMDDTHHMMSS>/a/<course>/<article>.html
```

- 文章 id 直接用 Notion page_id（小写带连字符，满足契约 `[a-z0-9-]`）：知识库 page id 前缀
  高度重合（`4107d604-ab11-…`），截前 12 位会撞车。
- 每篇文章在 index.json 里带 `sha`：最终 HTML 字节 sha256 前 16 位（小写 hex），同 release 内唯一。
  App 应该用 `sha` 判断正文是否要重下（`updated` 只是 Notion 编辑时间，cleaner/模板变化不会变它）；
  增量与全量都会写，`verify.py` 会校验存在性/格式/唯一性并与文件字节比对。
- 每轮同步一个 release，保留最近 3 个（`output.keep_releases`）；index 引用的 release 不会被删。
- 失败时不动 index：旧版本继续服务；上一轮 release 保留给回滚。

## 环境准备

```sh
# Python：现有共享 venv 已含 requests/Pillow/PyYAML；也可以用 uv
#   uv sync
~/.venvs/main/bin/python -c "import requests, PIL, yaml"

# node 依赖（mermaid 预渲染；只需一次）
cd tools/notion-sync && npm install
```

本机 Chrome 路径默认 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`，
mermaid 字体默认注入 App 的 `app/src/main/assets/web/fonts/fusion-pixel.woff2`（均可在 `config.yaml` 改）。

## fixture 模式（无 token，开发/验收）

```sh
bash run.sh --from-fixtures ~/workspace/sandbox/tasks/shubian-notion-kb/fixtures --dry-run
~/.venvs/main/bin/python verify.py
```

fixture 目录格式见契约 §5（`inventory.json` + `pages/<page_id>.md|.json` + `media/`）。
fixture 模式下 API、图片下载被跳过，但清洗/渲染/产物逻辑与真实模式完全一致。
`--dry-run` 不写增量 state、不发布（mermaid 渲染缓存仍会写在 `state/mermaid-cache/`）。

## 真实模式

```sh
# 一次性：把只读 token 写进 600 文件（不进 Git；不要贴到聊天/日志）
mkdir -p ~/.config/shubian-kb && chmod 700 ~/.config/shubian-kb
printf 'NOTION_TOKEN=ntn_xxx\n' > ~/.config/shubian-kb/env && chmod 600 ~/.config/shubian-kb/env

bash run.sh                # 增量
bash run.sh --full         # 全量重建
bash run.sh --limit 3      # 只处理前 3 篇（开发）
```

Notion 侧准备（约 5–10 分钟，Workspace Owner）：

1. <https://www.notion.so/my-integrations> → Build → Internal connections → 新建连接（如 `shubian-kb-reader`）。
2. Configuration → Capabilities 只勾 **Read content**；复制 API token。
3. Content access → 把「知识库」根页分享给该连接（子页自动继承）。
4. token 写进上面的 600 文件；`run.sh` 自动 source，sync.py 只从 `NOTION_TOKEN` 读，不打印。

调度（建议 launchd，30–60 分钟一次）：`ProgramArguments` 指到 `run.sh`，`StartInterval=1800`，
`RunAtLoad=false`，日志重定向到 `logs/sync.log`。

## 发布（默认关闭）

> ⚠️ 改过 cleaner/mdparse/HTML 模板后，光跑增量会复用旧 HTML（硬链接上一 release）。改完必须先 `bash run.sh --full --publish` 全量重建，再让 launchd 继续增量。

`config.yaml` 的 `publish.enabled` 默认 `false`；不加 `--publish` 时只构建并把 rsync/scp 命令以
`# dry-run publish:` 打印出来。真正发布需要：

```sh
# ~/.config/shubian-kb/env（600）里已有：NOTION_TOKEN / KB_SECRET / KB_BASE / REMOTE / REMOTE_DIR / KUMA_PUSH_URL
# config.yaml: publish.enabled: true
bash run.sh --publish
```

顺序：先 `ssh sudo install -d` 建远端目录（首次发布需要）→ `media/`（`--ignore-existing`，内容寻址）
→ release 目录 → `index.json`/`status.json` 传 `.tmp` 后 ssh `mv` 原子替换。执行日志里远端
secret 路径会打码成 `<REMOTE_DIR>`，不会落盘。远端 Caddy 侧：`index.json`/`status.json` `no-store`，
`media/*`、`releases/*` 长期 immutable，`X-Robots-Tag: noindex`。

## 课程结构、过滤与排序

- **分区页递归**：hub 的直接子页里，**有 child_page 子页的页面视为分区**（如量化 F/G），
  分区自身不进文章、展开其子页（递归深度 ≤2）。编号页（`第N讲`/`A1`/`T1`…）不做子页探测，
  避免把「恰好有子页的文章」误展开。`config.courses[].sections` 仍作为强制分区兼容。
- **过滤**：标题命中 `待发布/待补充/待写`、`^作业`、`毕业项目`、`跨讲总纲/自测题库/实验、作业与
  项目路线`、`模板$/方案评审 10 问` 的页面排除（`filters.exclude_title_patterns`，可带 reason）；
  fixture 里 `kind` 为 placeholder/composite/template/section/assignment/project 的也排除。
- **排序**：课程内按标题自然排序——`第N讲`→N（支持中文数字）、`A1/B3/F1/G2/T1`→(字母, 数字)；
  无编号的保持 Notion 原顺序。用于修正量化 C 区 `C3,C1,C2…` 这种子页顺序错乱。
- **占位页判定**：标题含待发布标记直接排除；**icon ⏳ 只有正文 < 1200 字才排除**（长文不受旧图标
  影响，例如 CS2680 第十二讲）；正文含占位标记也仅在正文 < `pending_body_chars` 时排除；
  清洗后 < `min_body_chars`(200) 的极短页排除。

## 清洗与渲染规则（对应 notion-audit §3）

- **删除**：开头 `导语｜`（R2）、页眉署名（含 `授课：`/`中文讲解文章`/`——`，R3）、
  H2「状态」整段（R19）、结尾 `第 N 讲完。`（R17，含粘在最后一段末尾的写法）、TOC 占位（R20）。
- **保留**：`核心要点回顾`（R4）、`来源/出处`（R18）、图注（R5）、mermaid 图题（R6）。
- 标题层级归一：body h1 → h2；h2/h3/h4 带稳定 `id="kb-sN"`。
- 图片：`图：`（图块内）优先，否则后随 `图注：` 段落；mermaid 前 `^图\d+[：:]` 段落变 figcaption。
- 未知块降级为段落/代码块，不丢内容；Notion 域名/签名 URL/`notion-file-block://` 一律不输出。
- CommonMark 反斜杠转义在文本层还原（`tb\_s1`→`tb_s1`、`KV\*2`→`KV*2`、`\$/successful`→`$/successful`）；
  `<pre><code>` 代码块、行内代码和 mermaid 源码保持原样。回归：`python -m unittest discover -s tests`。
- 两处历史脏数据兜底：① 被转义、`<br />` 粘成一行的 ```mermaid 会先还原成真代码块再渲染
  （渲染失败才保留源码）；② `$$...$$` display math 因为 App 没有 KaTeX，统一降级为
  `<pre><code class="language-math">` 原样展示，避免 LaTeX 的 `\`/`\[` 被当成 Markdown 转义。

素材：图片按字节 sha256 内容寻址；Pillow 转 WebP（长边 ≤1600、q82，透明图保留 alpha）。

mermaid 每个代码块同步渲染**浅色 + 暗色两版内联 SVG**，同一个 `figure.kb-mm` 里并排输出
`<svg class="… kb-mm-light">` 与 `<svg class="… kb-mm-dark">`（共用 figcaption，App 按阅读主题
显示其中一版；不再产生 `kb-mm-wide` / 单 SVG 旧结构）：

```html
<figure class="kb-mm">
  <svg class="flowchart kb-mm-light" viewBox="0 0 1172 154">…</svg>
  <svg class="flowchart kb-mm-dark"  viewBox="0 0 1172 154">…</svg>
  <figcaption>图1：…</figcaption>
</figure>
```

- 两版用同一个渲染函数跑两遍（仅 theme 不同），渲染器断言 **viewBox 完全一致**；不一致按失败
  退回源码，不产出单版 figure。
- 暗色主题：`theme:'dark'` + themeVariables 覆盖 —— 透明背景、卡片面 `#26282c`、文字/边
  `#c9ccd1`、强调色朱红 `#a9471d`（`render_mermaid.mjs` 顶部 `DARK_THEME_VARIABLES`）。
- 浅色版保持原 `default` 主题（视觉不变），`fontSize: 24`（Fusion Pixel 12px 的整数倍）。
- 两版 SVG 缓存 `state/mermaid-cache/<code_hash>.{light,dark}.svg`；任一版渲染失败则整图回退
  `<pre><code class="language-mermaid">`，不计 figure。
- 超宽图（viewBox 宽 >1800 的图约 86 个、>2400 有 13 个、最宽 3658）：产物侧**不做**全局/逐图
  收窄——SVG 本身是矢量、CSS 已自适应宽度；再压窄只能改图源布局（nodeSpacing/rankSpacing/
  wrappingWidth/字号）或强制改 viewBox，会失真或裁切，且全局 config 会伤害其余图。建议 App
  阅读器对宽图提供横向滚动/缩放/全屏（App 侧超大图优化），同步侧只保留原始 viewBox。

## 校验

```sh
~/.venvs/main/bin/python verify.py [--dist DIR] [--json]
```

检查 index schema、文章数一致、路径存在、无 Notion 域名/签名 URL/`script`/`iframe`/`on*`、
图片非空且为 WebP、mermaid 全部为内联 SVG 或 fallback、内链目标存在，并打印字节统计。

## 真实模式冒烟（2026-11-07 已跑通）

`bash run.sh --limit 1 --dry-run --dist tmp/dist-real`（真实 token，只跑 CS2680 第一讲）：

- 发现：4 个 hub 子页遍历 + 页面元数据 = 80 次 API 调用；耗时 45s（含首轮图片下载/mermaid 渲染）。
- 正文：`markdown_version=v2` 返回 10,138 字符，`truncated=false`、`unknown_block_ids=[]`。
- 图片：真实 markdown 用 `<image source="https://prod-files-secure.s3…?X-Amz-Expires=3600#notion_record=block…" />`
  （不是 fixture 的 Markdown 图片语法）。cleaner 两条分支都支持：解析 → 当轮立即下载 → Pillow 转 WebP
  （2 张：42,030 + 21,108 字节，1192×723 / 1260×634），产物只出现 `/kb/i/<sha>.webp`。
- mermaid：2 个代码块 → 2 个内联 SVG，0 失败；`verify.py` PASS。
- 产物：`tmp/dist-real`（1 篇）、`dist/`（fixtures 4 篇）都通过 `verify.py`。

## 真 token 上线前要再确认的 3 点

1. **`page.last_edited_time` 的增量覆盖度**：只改子 block 时是否一定更新；上线后采样验证，
   漏检就调低 `--full` 周期（建议先每天一次全量兜底）。
2. **signed URL 过期后的重取路径**：目前每轮取到正文后立即下载（同日实测 2 张图正常）；
   若图片下载 403/过期，只记错误并跳过该图，不会自动重取 markdown 换 URL。全量 68 篇时若
   出现跨小时的长任务，需要补一条「重取正文换新签名」的分支。
3. **全量真实语料的过滤与兼容性**：占位页（第十二讲、T2–T5、「待发布」）靠标题+正文标记+
   `min_body_chars` 三重过滤，需要看误收录/漏收录；mermaid 看坏块/子图/gantt 的 fallback 比例，
   图片看 jpg/heic 的 Pillow 解码失败率。
