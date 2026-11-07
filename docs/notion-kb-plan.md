# 书边译 ·「课程」板块（Notion 知识库同步）方案

2026-11-07 · 调研：Lead + 3 个只读调研任务（Notion 内容审计 / App 集成 / 同步与托管）

## 0. 结论

**能做。** 推荐做法：

- **同步进程放这台常开的 Mac**（launchd，每 30 分钟）：拉 Notion → 清洗正文 → 下载图片 → 本地 Chrome 把 mermaid 转 SVG → 构建静态内容包 → rsync 到 jimmy VPS。
- **托管沿用现有发布通道**：`update.lemonation.cloud`（jimmy `/var/www/shubian-kb/<secret>/`），只加静态目录和一段 Caddy，不动 DNS/TLS。
- **App 里加第 4 个标签「课程」**：课程列表 → 文章列表 → 阅读页；内容增量下载到本地，离线可读；图片点开看大图，mermaid 以预渲染 SVG 显示。
- **Notion MCP 已装，但不能当同步进程用**（它只是交互式 OAuth 会话，access token 约 8 小时、会轮换、只面向 `mcp.notion.com`）。正式同步需要你在 Notion 建一个**只读 internal connection token**，约 5–10 分钟，token 只放 Mac 上，不进 App/仓库。
- 工作量：P0 原型 0.5 天；P1 同步+发布 1–2 天；P2 App 2–3 天；P3 打磨 0.5–1 天。合计约 **4–6 个工作日**（AI 辅助），之后每轮增量同步 40–120 秒。

**默认内容口径**（可按你的回答调整）：4 门课、68 篇已发布文章进 App；10 个「待发布」占位、4 个综合页、3 个模板页不进；文章内去掉「导语｜」段、页眉署名、「状态」段和结尾残句，保留正文（含「核心要点回顾」「来源」）、图注和图表。

## 1. 需求定义

| 你提的 | 本方案的落点 |
|---|---|
| 在书边译里新增板块，展示 Notion 知识库 | App 第 4 个标签「课程」，数据来自 Notion 知识库 4 门课 |
| 后面会在 Notion 加笔记，要能同步 | Mac launchd 定时增量同步（30 分钟），App 自动拉更新 |
| 不需要 Notion 原生界面，做手机适配界面 | 复用 App 现有像素风 UI + 阅读设置；外屏单栏、内屏左列表右文章 |
| 只要课程标题和里面的文章，不要导读等 | 课程 hub 页不进内容；正文按规则清洗（见 §3.4） |
| 能看到文章里的图解和流程图 | 图片同步时转存 WebP；mermaid 同步时预渲染成 SVG，随文章内联 |

**本期不做**：Notion 写回、全文搜索、每日简报/文档库板块、文章内长按查词（可做二期）。

## 2. 可行性核查（先看能不能做）

### 2.1 内容侧（Notion）

知识库 `📚 知识库` 的 8 个顶层页里，有 4 个是「课程 → 文章」结构，共 **68 篇已发布文章**：

| 课程 | 文章数 | 说明 |
|---|---|---|
| 🎓 CS2680 · 现代 AI 系统 | 12 | 第一至十一讲 + 作业 3；第十二讲等 6 个「待发布」过滤掉 |
| 🧠 Berkeley Advanced LLM Agents | 12 | 第 1–12 讲 |
| 📈 量化交易知识库 | 43 | A/B/C/D/E 系列 + F1–F3 + 毕业项目，无中间目录页 |
| 🏛 架构与设计 · 中高级知识地图 | 1 | T1 已发布；T2–T5 待写 |

抽样 14 篇 + 1 个综合页的实际构成：

- 版式：H2/H3 + 长段落 + 列表 + 表格（Berkeley/量化/架构多，1–8 个/篇）+ callout；CS2680 是「长文 + 图 + mermaid」。
- **图片**：全部是 Notion 托管的上传图（PNG，实测 53–102 KB/张），全库约 80–100 张、5–10 MB；**URL 是预签名短链，同步时必须立即下载转存**，App 不能直连。
- **流程图**：mermaid 代码块，抽样 14 篇里 35 个，全库估计 120–160 个；flowchart / sequenceDiagram / stateDiagram / gantt 都有，大量中文节点、`<br/>`、中文引号，另有少量历史坏块（渲染失败要能退回显示源码）。
- **公式**：正文没有 LaTeX（公式都写成纯文本），只有综合页有 `$$…$$`；综合页默认不进，所以**不需要 KaTeX**。
- 不统一的地方：标题层级（有的有 H1 有的没有）、图片 caption 有两种写法（图后「图注：」/ 图块内「图：」）、mermaid 图题写在代码块前（`图1：…`）——清洗器按规则归一化。

### 2.2 App 侧（书边译）

- 结构：单 Activity + 全屏 WebView，页面来自 `https://app.local/`（`shouldInterceptRequest` 从 assets 读），**非 app.local 请求一律 404**，所以页面不能直接 fetch 外网 —— 内容必须走原生桥 + 本地 `/kb/` 路由。
- 加标签很轻：现有 3 个标签是「nav 按钮 + view + render 查表」，加第 4 个是 1 个按钮 + 1 个 view + `renderKb` + 返回键分支（细节见 `sandbox/tasks/shubian-notion-kb/app-integration.md`）。
- 阅读设置（6 套主题、字号、行距、字体）可复用；但 `app.js:1834` 的 `if (!R) return;` 是书阅读器闸门，必须先拆成通用 setter，否则课程页里主题/字号点了没反应。
- APK 已 25.1 MB（SPEC 上限 25 MB），**不能把 mermaid.js/KaTeX 塞进 App** → 选「同步侧预渲染」；App 只存 HTML/图片/SVG，体积基本不增。
- 需要新增：`Kb.java`（清单/文章/图片下载、原子写、内容寻址去重、GC）+ `/kb/` 本地路由 + 6 个桥方法。

### 2.3 基础设施

- 这台 Mac：M2 Pro / 16 GB，已连续运行 27 天，休眠被 `caffeinate` 阻止，有 Chrome 157、Node 24、Python 3.12；panel 项目的 launchd + rsync + Caddy 发布模式已经跑熟。
- jimmy VPS（43.131.233.151）：已运行 190 天，2 vCPU / 3.6 GB / 26 GB 可用磁盘，Python 3.12、Node 20、Caddy；`update.lemonation.cloud` 已经在用它（`/var/www/fold-ds-updates`）。
- 两边都实测能连 `api.notion.com` 和 Notion 图片 CDN。
- 结论：网络和机器都不是瓶颈。

### 2.4 Notion 鉴权（MCP 能不能用来同步？）

- 已装的 `dsh-notion-mcp` 是官方 Notion MCP 的 OAuth 客户端：token 存在 DSH 凭据层，access 约 8 小时，refresh 会轮换且与交互会话互踢，只面向 `mcp.notion.com`，没有无头/常驻模式。**不能复用，也不该复用。**
- 正确做法：Notion → Settings → Connections（`notion.so/my-integrations`）建一个 internal connection，只勾 **Read content**，把「知识库」根页分享给它（子页自动继承）。得到 `ntn_…` token，写进 Mac 的 `~/.config/shubian-kb/env`（600），不进 Git/APK。
- API 细节：180 请求/分钟（平均 3/s）；`GET /v1/pages/{id}/markdown?markdown_version=v2` 一次拿整页 Markdown（约 2 万 block 上限，`truncated` 的块可补取），全量约 130–200 次调用、6–12 分钟；增量 40–120 秒。不支持块退回 block children 接口。
- 风险与兜底：新 Markdown 接口要先冒烟；若某个页面/图片失败，保留旧版内容继续服务，指数退避重试，不阻塞整轮。

## 3. 推荐方案

### 3.1 总体架构

```
Notion 知识库（4 门课 / 68 篇）
        │  Notion API（只读 internal token，180 req/min）
        ▼
Mac 常开本机：launchd 每 30 分钟跑 sync/
  ├─ 发现课程/文章（hub 子页 + last_edited_time 增量）
  ├─ 取整页 Markdown → 清洗成文章 HTML
  ├─ 立即下载图片 → WebP（长边 ≤1600，内容哈希命名）
  ├─ 本地 Chrome 157 批量渲染 mermaid → SVG
  ├─ 生成 index.json + release 目录（原子替换，保留 3 份）
  └─ rsync → jimmy（媒体内容寻址，只传新增/变更）
        ▼
jimmy VPS：/var/www/shubian-kb/<128-bit secret>/
  Caddy：update.lemonation.cloud/shubian-kb/…
  index no-store；media immutable；X-Robots-Tag: noindex
        ▼
书边译 App：第 4 个标签「课程」
  ├─ Kb.java 拉 index.json，只下载变更文章/图片 → filesDir/kb/
  ├─ /kb/ 本地路由给 WebView（离线可读）
  └─ 列表 / 阅读页 / 6 套主题 / 阅读进度
```

### 3.2 同步进程放哪里：选 Mac

| 方案 | 加权分（调研） | 结论 |
|---|---|---|
| **A. Mac launchd + rsync 到 jimmy 静态站** | **4.60** | **推荐**：token 只在家里的 Mac；本机 Chrome 直接预渲染 mermaid（VPS 没 Chrome，2 vCPU 装 Chromium 吃力）；复用 panel 的 launchd/rsync/Caddy 模式；App 缓存兜底，Mac 短暂离线不影响已读内容 |
| B. jimmy VPS cron 直跑 | 3.90 | 网络/托管都可行，但要装 Chromium、token 放公网服务器；作为备选（流水线可整体搬） |
| C. GitHub Actions | 3.45 | 调度漂移、图片存储/Secret 都外置，不值 |
| D. App 直连 Notion API | 2.00 | token 进 APK、图片 1 小时过期、无离线，排除 |

Mac 的风险：launchd 跟着登录会话，重启/注销后要等登录；兜底是 App 本地缓存 + Uptime Kuma 心跳告警 + 手动 `bash sync/run.sh --full`。如果以后 Mac 不可靠，把 `sync.py` + Chrome 装到 VPS 即可平移。

### 3.3 同步流水线（Mac）

目录：`~/workspace/shubian-notion-kb/`（独立于 App 仓库，可用私有 Git）

```
sync/config.yaml        roots（4 个 hub 页 ID）、排除规则、输出/发布参数
sync/sync.py            发现 → diff → 取 Markdown → 清洗 → 资产 → 构建 → 发布
sync/render_mermaid.mjs puppeteer-core + 本机 Chrome，批量渲染 SVG
sync/run.sh             flock 加锁、读 token、跑 sync.py、写心跳；支持 --full/--dry-run
state/state.json        page_id → {last_edited_time, markdown_sha, release}
logs/sync.log           newsyslog 5MB × 3
```

- 调度：`~/Library/LaunchAgents/com.jimmy.shubian-kb-sync.plist`，`StartInterval=1800`，`RunAtLoad=false`，`ThrottleInterval=300`，`ProcessType=Background`。
- 增量：hub 子页递归列出 → 对候选页读 `last_edited_time` 比对 `state.json` → 只取变更页 Markdown；上线先采样验证「改子块会不会更新 last_edited_time」，漏检则退化为每 N 小时全量刷。
- 发布：先传媒体（内容寻址，已存在跳过）→ release 传进 `.tmp` 后 `mv` 成 `releases/<ts>` → `index.json` 用 `.tmp` + `mv` 原子替换 → 失败不动 index；保留最近 3 个 release，`index-<ts>.json` 供一键回滚。
- 监控：`state/last-run.json` + Uptime Kuma Push 心跳（连续 2 次没心跳告警）；在 `~/ops-hub/portfolio.yaml` 登记 `shubian-kb`，`status.json` 作探活。

### 3.4 内容提取规则（课程 / 文章 / 正文）

1. **课程**：知识库页下 4 个 hub（白名单写在 `config.yaml`，以后加课程改这里）。
2. **文章**：hub 的直接子页，`status=published`；排除 `placeholder`（标题含「待发布」/icon ⏳）、`composite`（跨讲总纲/自测题库/实验作业路线）、`template`（技术方案模板/ADR 模板/评审 10 问）、`section`（量化 F 分区页）。默认 68 篇。
3. **标题**：用页面 title；剥掉 `📘/📄/📋/🧩/🎓` 等 emoji 前缀；副标题/署名（「——…｜授课：…」「中文讲解文章」）剥掉。
4. **正文清洗**：
   - 删除：开头「导语｜」段、首两块的页眉/署名、H2「状态」段、结尾「第 N 讲完。」残句、`<table-of-contents/>`。
   - 保留：H2/H3、段落、有序/无序列表（含嵌套）、表格、callout、图片 + 图注、代码块、引用、外链。
   - 「核心要点回顾」「来源/出处」默认保留（是正文总结/参考，不是导读）；要更干净可加白名单开关去掉。
   - 页内 `mention`（跳到其他文章）：目标在 68 篇里 → App 内跳转；不在 → 显示原链接，点击用系统浏览器打开；其他外链同。
5. **图片**：按块顺序内联；caption 两套写法都归一成 `<figure><figcaption>`；`图N：` 段落作为 mermaid 的 caption；转 WebP（长边 ≤1600、q80），另存宽/高避免加载抖动；内容哈希命名、全库去重。
6. **mermaid**：同步侧用本机 Chrome + `puppeteer-core` 渲染成 SVG，**渲染页安装 App 同一份 `assets/web/fonts/fusion-pixel.woff2`**、`fontFamily` 配同一字族，保证中文节点排版和 App 一致；SVG 去 width/height 留 `viewBox`，随文章内联；渲染失败退回 `<pre>` 源码（不丢内容）。暗色先做「单份 SVG + CSS 覆盖」，截图验收不过再做浅/深两份。
7. **产物**：每篇独立 HTML（自包含、白名单净化，无 script/iframe/事件属性），`index.json` 只做目录/元数据；App 不做 HTML 解析。

### 3.5 托管与访问

- `jimmy:/var/www/shubian-kb/<secret>/`，`secret = openssl rand -hex 16`（128 bit，只在 App BuildConfig 和服务器目录名里，不进 Git/Caddyfile）。
- Caddy 在 `update.lemonation.cloud` 加 `handle_path /shubian-kb/*`：`index.json/status.json` `no-store`；`media/*`、`releases/*` `public, max-age=31536000, immutable`；加 `X-Robots-Tag: noindex, nofollow`；关目录浏览。
- 可选第二层：Caddy 校验 `X-KB-Token` 请求头（App 原生请求能带），不配也不影响使用。**不推荐 Tailscale 常开**（手机耗电、外网体验差）。
- 注意：`update.lemonation.cloud` 的 Caddyfile 在 `~/ops-hub/deploy/fold-ds-updates/Caddyfile`，改动要同步到服务器 `/opt/ops-hub/`，`caddy validate` 后 reload。

### 3.6 App 集成

- **第 4 个标签**：nav 加 `<button data-tab="kb">`，`#v-kb` section，`render` 表加 `kb: renderKb`，返回键加 KB 分支；外屏底部 4 项、内屏侧栏 4 项。命名避开 `st.kb`（已是键盘标志）。
- **列表页**（外屏单栏 / 内屏左栏 300dp）：顶部「继续阅读」+ 4 张课程卡（标题、篇数、已读进度）+ 文章行（标题、字数/阅读时长、已读、`新` 标记）；内屏右侧 352dp 显示文章，可「专注」隐藏侧栏到 560dp。
- **阅读页**（外屏全屏层，盖住 nav；内屏右栏）：标题 + 正文；复用 6 套主题、字号/行距/字体设置；H2 自动生成目录；图片点开全屏；表格横向滚动；代码块等宽；mermaid SVG `max-width:100%`；滚动进度按文章存 `kbprog`。
- **数据**：`Kb.java` 用 `HttpURLConnection` 拉 `index.json`（`If-None-Match`）→ 对比本地 `release/updated` → 下载变更文章与图片 → `.part` → `mv` 原子写；文章存 `filesDir/kb/a/<course>/<id>.html`，图片存 `filesDir/kb/i/<sha>.webp`；`serve()` 加 `/kb/` 路由从 filesDir 读，**Cache-Control: no-store**；打开标签先读本地缓存立刻渲染，缓存超过 6 小时或用户点刷新才后台同步。
- **桥**：`kbSync(v)` / `kbIndex()` / `kbStats()` / `kbCancel()` / `kbClear()` / `openExternal(url)`；进度/事件走 `emit("kb", …)`，文章 HTML 不过桥（走 `/kb/` 文件路由，避免大字符串阻塞 JS）。
- **降级**：清单拉取失败保留旧索引、绝不清空；单篇缺失点行即时补拉；离线时显示「离线 · 显示缓存」+ 行内重试。

## 4. 分阶段实施计划

| 阶段 | 做什么 | 产出 / 验收 | 估时 |
|---|---|---|---|
| **P0 原型** | 用 Notion MCP 手动导 3–5 篇（覆盖 mermaid/图片/表格三种版式），按目标样式做 HTML，装进 App 的临时页面 | Fold 模拟器外屏/内屏各看一遍；确认「导读/核心要点/图注」口径；不需要 token | 0.5 天 |
| **P1 同步+托管** | 你建 token；写 `sync.py` + mermaid 渲染 + 图片管线 + index + rsync + launchd + 监控；加 Caddy 路径 | 服务器上能看到 68 篇；手动改一篇 Notion 后 30 分钟内 App 端 index 更新；Kuma 心跳正常；可回滚 | 1–2 天 |
| **P2 App 板块** | 第 4 个标签、课程/文章列表、阅读页、主题复用、`Kb.java` 缓存、离线、返回键、折展保持 | gradle 四件套通过；模拟器外屏/内屏/折叠保持/断网可读；APK 体积不超上限；首屏 <1s（本地缓存） | 2–3 天 |
| **P3 打磨（可选）** | 内链跳转、目录、图片手势缩放、「新」标记、缓存管理入口、阅读进度同步 | 逐项验收 | 0.5–1 天 |

## 5. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| Notion Markdown 接口行为与预期不符 | 同步拿不到正文 | P1 第一步冒烟；失败退回 block children 递归（多几次请求，仍可行） |
| 图片预签名 URL 过期 | 图片 404 | 取到 Markdown 后当轮立即下载落盘，失败重取该页；永不把 Notion URL 存进 App |
| `last_edited_time` 漏检「只改子块」 | 内容不更新 | 上线采样验证；兜底定时全量刷（60–90 次请求，成本可接受） |
| mermaid 中文字体/暗色不一致 | 图排版溢出、深色下看不清 | 同步侧装 App 同一字体、锁 mermaid 版本；P0 就截图验收深浅两套；失败退源码 |
| 大图内存 | WebView OOM | 同步侧压到长边 ≤1600 WebP；HTML 带 width/height + lazy |
| Mac 重启/注销后同步停 | 内容变旧 | 不阻塞阅读（App 有缓存）；Kuma 心跳告警 + 手动补跑；必要时迁 VPS |
| 内容被公开访问 | 私人笔记泄露 | 128-bit 不可猜路径 + noindex；可选请求头 token；将来分发 APK 前换 secret |
| 页面结构以后变了 | 过滤失效 | 清洗规则配置化（config.yaml）+ 未知块降级显示 + 同步日志列出「可疑页面」 |
| APK 变胖 | 超 SPEC 25MB | 不在 App 塞 mermaid/KaTeX（服务端预渲染）；P2 验收时检查体积 |

## 6. 需要你做 / 确认的

**需要你操作（5–10 分钟，P1 开始前）**
1. 打开 `https://www.notion.so/my-integrations` → Build → Internal connections → 新建 `shubian-kb-reader`，Capabilities 只勾 **Read content**。
2. Content access 勾「知识库」根页（子页自动继承）。
3. 复制 `ntn_…` token 发给我的会话/自己写进 `~/.config/shubian-kb/env`（600 权限，不进 Git）。

**需要你拍板的 3 个内容口径**（默认值见 §0/§3.4）
1. 课程范围：4 门课全要（68 篇），还是只要 AI 两门（CS2680 + Berkeley，24 篇）？
2. 文章内：「核心要点回顾」「来源/出处」保留吗？（默认保留）
3. 综合页、作业/毕业项目、模板页：默认都不进课程列表；要不要单列「附录/专题」？

**开始方式**：建议先做 P0 原型（不用 token、0.5 天），你看到实际阅读界面并确认口径后再做 P1/P2；也可以直接按 P1→P2 一次做完。

## 7. 备选方案

- **B. jimmy VPS 直跑同步**：少一次 rsync、发布延迟更低；代价是装 Chromium（2 vCPU/1.9 GB 可用，首轮渲染慢）和 token 放公网服务器。A 出问题时整体平移。
- **C. 纯网页版（PWA）**：同步产物本身做成手机适配网页，App 里只加一个入口打开；实现最快（约 1–2 天），但离线依赖 Service Worker、和 App 的整合感弱，适合先上线试用、后续再升级成原生板块。
- **D. MCP 手动导出**：只适合做 P0 原型，不能当同步（逐页交互、图片过期、无增量）。

## 附：调研原始报告

- Notion 内容审计：`../sandbox/tasks/shubian-notion-kb/notion-audit.md` + `inventory.json`
- App 集成分析：`../sandbox/tasks/shubian-notion-kb/app-integration.md`
- 同步与托管调研：`../sandbox/tasks/shubian-notion-kb/sync-arch.md`

Notion API 参考：[Retrieve a page as markdown](https://developers.notion.com/reference/retrieve-page-markdown)、[Working with markdown content](https://developers.notion.com/guides/data-apis/working-with-markdown-content)

## 8. 实施状态（2026-11-07 晚）

- P0 原型（fixture 4 篇）→ 管线与 UI 已在真实语料上跑通，跳过独立 P0。
- P1 同步 + 托管：已完成。真实 Notion 80 篇（CS2680 12 / Berkeley 12 / 量化 48 / 架构 8）；图 66 张 1.9MB、mermaid 436 张 SVG、HTML 12.85MB（总 14.84MB）、转义残留 0；`verify PASS`。发布在 `update.lemonation.cloud/shubian-kb/<secret>/`（Caddy no-store/immutable/noindex）；Mac launchd `com.jimmy.shubian-kb-sync` 每 30 分钟增量 + 发布，ops-hub 登记 `shubian-kb`。
- P2 App：已完成并实测。第 4 标签「课程」；外屏列表/全屏阅读、内屏 300+352dp 分栏；6 套主题、字号/行距、进度、离线缓存、图片放大、mermaid SVG、内链跳转；release APK 1.23/24 为 25,132,028 B（+8.1KB）。模拟器外屏/内屏/折叠/暗色/断网重开截图在 `../sandbox/tasks/shubian-notion-kb/emulator-screens/`。
- 2026-11-07 追加：内屏（小米 18 Fold）阅读优化——默认全屏正文、顶栏随滚动收放、沉浸模式隐藏系统栏并记忆偏好、横屏 38em/竖屏满宽、旋转按比例保持滚动位置；1.24/25 发布。旧的内屏「左列表+右窄栏」截图作废。
- 2026-11-07 追加二：Mermaid 体验——文内不再横滑（自适应宽度/高图 68vh）、每图「查看大图」角标；新增统一全屏媒体查看器（mermaid+图片）：适应宽度/整图/按钮与捏合缩放/拖动/旋转/双击，窄屏原生 100% 打开看细节；1.25/26 发布。
- P3 未做：宽 mermaid 暗色双份 SVG、未收录内链的外部链接、仅 WiFi 同步、Kuma 心跳。
- 运维：`~/.config/shubian-kb/env`（600）存 Notion token 与内容 secret；Caddy 片段在 `~/ops-hub/deploy/fold-ds-updates/Caddyfile`（服务器 `/opt/ops-hub/`），改前备份 `Caddyfile.pre-shubian-kb-20261107`。
- 注意：改 cleaner/HTML 模板后必须 `bash run.sh --full --publish` 全量重烘焙；App 端按每篇内容 `sha` 判断增量（不要只看 Notion `updated`）。

## 9. 已确认的决定（2026-11-07）

- 内容范围：**4 门课全收（68 篇）**；综合页/作业/毕业项目/模板页不进板块；待发布占位不显示。
- 文章正文：保留「核心要点回顾」「来源/出处」「图注」；去掉开头导语、页眉署名、「状态」段、结尾残句。
- 实施路径：**直接做 P1+P2 完整版**（不等 P0 原型），并用 fixture（MCP 导出的真实文章）先跑通同步管线与 App 界面，Notion token 到位后切真实同步。
- 数据契约见 `docs/notion-kb-contract.md`（同步产物与 App 缓存的唯一接口约定）。
