# 书边译 开发文档

版本 1.0（2026-10-31）。这是开发依据；`README.md` 是方案背景，二者冲突时以本文为准。界面、动画和交互以原型 `prototype/index.html` 为准，本文写不到的视觉数值（间距、圆角、颜色）直接读原型的 CSS。

## 0. 产品一句话

给一个人自用的看书查词 Android App，装在小米 18 Fold（HyperOS 4，国行，无 Google 服务）。三个标签：

1. **查单词**（首页）：打开就能输入，逐字出离线释义；读纸书时拍一页，挑出生词。
2. **书库**：导入 ePub，在 App 内阅读，阅读界面参照 Apple Books，长按单词查词。
3. **生词本**：收藏过的词。

另外，在别的 App 里选中文字时也能调出词典卡片。

## 1. 工程约束

| 项 | 要求 |
|---|---|
| 包名 | `app.shubian` |
| App 名 | 书边译 |
| 语言 | Kotlin，原生 View |
| 依赖 | 不用 AndroidX、Compose、Material、OkHttp/Retrofit、epub 库、图片库。允许：Kotlin 标准库、kotlinx-coroutines（可选）、ML Kit 文字识别（§3.3，它自带的传递依赖可以接受） |
| SDK | `minSdk 33`，`targetSdk 36`，`compileSdk 36` |
| ABI | 只打 `arm64-v8a` |
| 构建 | 提交 Gradle wrapper；AGP、Kotlin 用当前稳定版。release 开 R8 和资源压缩，用本机 debug keystore 签名（自用侧载，保证升级签名一致） |
| 网络 | `HttpURLConnection` |
| 存储 | 系统 `android.database.sqlite` |
| 密钥 | Jev Key 构建时从本机私有文件注入 BuildConfig（见 AGENTS.md），设置页不再输入；翻译 Key 在 App 设置里输入，存应用私有 SharedPreferences。两者都不得写进源码、测试、日志或 Git |
| 版本管理 | 在项目根目录 `git init`，每个里程碑至少一个 commit。`.gitignore` 排除 `build/`、`local.properties`、`*.jks`、`.env` |

本机环境：Android SDK 在 `~/Library/Android/sdk`（platforms 34 到 37，build-tools 36.1.0），JDK 21，Gradle 9.8.1，模拟器 AVD `Fold_DS_API36`（Pixel 9 Pro Fold 外形，API 36，arm64，可折叠）。

建议目录：

```
app/src/main/java/app/shubian/
  dict/      词典查询、词形还原
  lookup/    查单词页、词典卡片、外部入口 Activity
  scan/      拍照找生词
  library/   书库、ePub 导入与解析
  reader/    阅读器、分页、翻页动画、WebView 桥
  words/     生词本、导出
  jev/       Jev 请求与解析
  settings/
  ui/        颜色、字体、通用 View
tools/build_dict.py      生成词典数据库
testdata/                测试用 ePub 和书页照片
```

## 2. 屏幕适配

| | 外屏 | 内屏 |
|---|---|---|
| 物理 | 5.38 英寸，1168 × 1712 | 7.58 英寸，2364 × 1672（展开后横向） |
| 估算 | 约 425 × 623 dp | 约 860 × 608 dp |

- 按当前窗口宽度分两档：小于 600dp 为紧凑（外屏），600dp 及以上为宽屏（内屏）。不要按设备型号判断。
- 主 Activity 和阅读器在 manifest 里声明 `configChanges="screenSize|smallestScreenSize|screenLayout|orientation|density"`，自己处理折叠和展开，不重建；切换后重新布局，保留输入内容、选中的词和阅读位置。
- 紧凑：底部标签栏（查单词、书库、生词本）。宽屏：左侧 208dp 侧栏，顶部显示 App 名。
- 支持横竖屏，不锁方向。

## 3. 功能规格

### 3.1 查单词（首页）

App 启动直接进入此页，搜索框获得焦点并弹出键盘（`windowSoftInputMode="stateVisible|adjustResize"`）。

空闲状态（输入框为空，且宽屏下没有选中词）：

- 搜索框在内容区垂直居中，并略偏上：下方留出内容区高度 12% 的空白。框高 60dp，圆角 18dp，背景 `bg2`，0.5dp 边框，`shadow-1`。左侧放放大镜图标，图标用 `accent-text` 色。占位文字「输入英文单词」17sp；输入的文字用 28sp 衬线体（Literata）。宽屏下最大宽度 520dp，水平居中。
- 搜索框下方 16dp 处放两个并排按钮「拍一页」「从相册选」：高 48dp，圆角 14dp，背景 `fill`。
- 再往下 32dp 是「最近查过」（14sp，`faint` 色，居中），下面是最多 8 个最近查过的词。每个词是一个圆角胶囊，衬线体 17sp，多行居中排列，点一下就查这个词。

输入状态：

- 输入第一个字符后，搜索框用 300ms 的 FLIP 动画（缓动 `cubic-bezier(.2,.8,.2,1)`）移到顶部；宽屏下同时把宽度缩到左栏宽度（360dp 减去左右边距）。按钮和最近查过隐藏，下方显示结果列表。
- 每次按键都按前缀查询，最多 12 条，短词排前面。每行第一行是词（衬线体 17sp 粗体），第二行是第一条释义（`muted` 色，单行，超出部分显示省略号）。
- 输入的是变形词时（如 `wharves`），先显示原形一行「wharf　wharves 的复数」。
- 输入框右侧有清除按钮。清空后，搜索框动画回到中间，键盘保持弹出。
- 回车（IME action search）查第一条。
- 紧凑：点结果，从底部弹出词典卡片（§3.2）。宽屏：左右分栏，左边是 360dp 宽的结果列表，右边是释义面板；输入框为空但有选中词时，左栏显示最近查过的列表。
- 查过的词加入「最近查过」（去重，最新的在前，保留 50 个）。

右上角（紧凑）或侧栏底部（宽屏）有一个设置图标，进入 §3.8。

### 3.2 词典卡片

App 内的查单词、阅读器、外部入口共用同一个卡片组件。内容从上到下：

1. 词头：衬线体 28sp。变形词显示原形，旁边小字注明「wharves 的复数」。
2. 音标和朗读按钮：朗读用系统 `TextToSpeech`，en-US。系统没有英文语音引擎时，隐藏朗读按钮。
3. 「本句中」框（只在能拿到句子时出现，即阅读器和拍照）：背景 `accent-soft`，先显示加载占位，拿到 Jev 结果后淡入义项；Jev 不可用时整框不显示。
4. 义项列表：词性用斜体衬线 14sp `faint` 色，释义 17sp。Jev 选中的义项标「本句」标签，并用 `accent-text` 色。
5. 「加入生词本」按钮（`accent` 底），已收藏时显示「已在生词本」。

词典里查不到时，显示「词典里没有 xxx」。配置了翻译 Key 时，再显示「问 AI」按钮（§3.9）。

位置：
- 紧凑：底部卡片，最高占屏幕 50%，可下拉关闭。在阅读器里，如果单词在页面下半部，卡片改从顶部出现，不能挡住单词。
- 宽屏：浮动卡片，宽 340dp。在阅读器里浮在另一页上；外部入口时放在右下角，卡片上有「换边」按钮，记住上次的位置。

### 3.3 拍照找生词

入口：查单词页的「拍一页」「从相册选」，以及桌面快捷方式「拍一页」。

1. 拍照：调用系统相机 `MediaStore.ACTION_IMAGE_CAPTURE`，输出地址用自己写的最小 ContentProvider 提供（不用 AndroidX FileProvider）。相册：`MediaStore.ACTION_PICK_IMAGES`。原型里的自制取景框不做。
2. 结果页：上半部分是照片，下半部分是状态文字，依次显示「正在识别文字」「正在判断哪些是生词」。识别完成后，扫描线从上到下扫过一次，生词在照片上逐个高亮（错开 60ms）。结果列表淡入。动画细节照原型。
3. OCR：ML Kit 文字识别，用内置模型版本 `com.google.mlkit:text-recognition`，不能用依赖 Google Play 服务的版本。识别失败时提示「没有识别到文字」并提供「重拍」。
4. 候选词：
   - 分词，转小写，词形还原。
   - 去掉专有名词：不在句首却首字母大写的词。
   - 去掉 3000 个最常用词（按 ECDICT `frq`），去掉用户标记过「认识」的词，同一原形去重。
5. Jev 判断难度（§5）：一次请求，每个候选词一道 noul 题。概率 ≥ 0.5 的列为生词，按概率从高到低排序；其余收进折叠的「还有 N 个可能认识的词」。
6. 语境义：对生词再发一次请求，每个词一道 choice 题，选出本段中的义项。
7. 结果列表每行显示：原形（衬线粗体）、音标、本段中的意思，右边是收藏星标和「认识」按钮。点行，照片上对应的词闪一下；点照片上的高亮，列表滚到对应行。点「认识」后，该词以后不再出现在拍照结果里，可在设置里清除这些记录。
8. 离线或 Jev 失败：跳过第 5、6 步，按词频从低到高列出候选词（最多 20 个）。顶部提示「离线判断，可能不准」。

Jev 返回的概率不在界面上显示。

### 3.4 书库

- 大标题「书库」，右上角「+」导入。
- 「继续阅读」：最近打开的在读书，显示封面、书名、作者、进度条。点它打开书。
- 筛选胶囊：全部、在读、读完。
- 封面网格：紧凑 3 列，宽屏 5 列。封面比例 2:3，圆角 4dp。封面下显示进度百分比、「新」（没打开过）或「读完」。
- 导入：
  - 「+」调用 `ACTION_OPEN_DOCUMENT`，类型 `application/epub+zip`，可多选。
  - 在别的 App（文件管理、浏览器下载）里用「打开方式」打开 .epub 时，也走导入：声明 `VIEW` intent-filter。
  - 文件复制到 `files/books/<sha1>.epub`；同一个文件第二次导入时，提示「已在书库」。
  - 导入时，新封面以缩放加淡入的动画出现在网格第一位，右下角显示转圈；解析完成后转圈变成「新」。
- 封面：用 ePub 自带的封面；没有封面时，按书名和作者生成：纯色底加衬线书名。配色从 Radix 色阶里按书名哈希选取。
- 长按封面弹出菜单：标为读完或未读、删除（需要确认）。
- 打开书：封面从网格里的位置放大到全屏，同时淡入书页（450ms）；关书时缩回原位置。照原型实现。

### 3.5 ePub 阅读器

**解析**
- 用 `java.util.zip` 读：`META-INF/container.xml` → OPF（metadata、manifest、spine）→ 目录。EPUB3 读 nav 文件，EPUB2 读 NCX。
- 不支持带 DRM 的书，导入时提示「这本书有加密，无法打开」。

**渲染**
- 每章一个 XHTML，放在 WebView 里。资源通过 `shouldInterceptRequest` 从 zip 里读，域名用 `https://book.local/`。
- 注入的 CSS 控制主题颜色、字体、字号、行高 1.62、两端对齐、自动断字（`hyphens: auto`，`lang` 取自书的语言）、首行缩进 1.5em、章首首字下沉，并用 CSS 多栏分页。页面四周边距按原型。
- 关掉 WebView 自带的文字选择和长按菜单，长按、点击、滑动都由原生代码处理。
- 宽屏默认双页：一屏两栏，中间有书脊阴影。设置里可以关掉。

**版面**
- 顶部居中是当前章节名（12sp，`r-muted` 色），底部居中是页码。全书页码在后台分页完成前先不显示；分页结果按（书、字号、字体、屏幕尺寸）缓存。
- 点屏幕左侧 28% 翻到上一页，点右侧翻到下一页，点中间切换工具栏，左右滑动也能翻页。音量键翻页可以在设置里开关，默认关。
- 工具栏：顶部左边是关闭，右边是书签（加书签时，丝带从顶部落下）。底部显示「第 x 页，共 y 页」或「本章剩 n 页」，右下角是菜单按钮，菜单里有：目录、查单词、主题与设置、本书生词。照原型。
- 目录：底部卡片（宽屏是居中卡片），里面有章节列表、当前章高亮、全书进度滑块、书签列表。
- 主题与设置：
  - 字号 A/A，14 到 26sp，步长 1。
  - 6 个主题，数值见下表。
  - 字体：Literata、Source Serif 4、系统无衬线。两款衬线字体都是 OFL 许可，打进 APK。
  - 翻页方式：仿真、滑动、淡入、无。选中某种方式时演示一次。
  - 宽屏时显示「双页」开关。
- 阅读位置存（spine 序号，章内字符偏移）。换字号、字体、主题，折叠或展开后，都回到包含这个字符的那一页。每次翻页后保存。

| 主题 | 背景 | 文字 | 次要文字 | 选中底色 | 阴影 |
|---|---|---|---|---|---|
| 原色 | #fcfcfd | #1c2024 | #8b8d98 | #ffdfb5 | #1c202438 |
| 安静 | #212225 | #b0b4ba | #696e77 | #462100 | #00000080 |
| 纸张 | #f9f9f8 | #21201c | #8d8d86 | #ffdfb5 | #21201c38 |
| 粗体 | 同原色，字重 600 | | | | |
| 平静 | #f2f0e7 | #3b352b | #71624b | #ffdfb5 | #3b352b38 |
| 专注 | #111110 | #ffe7b3 | #6f6d66 | #462100 | #00000099 |

主题只影响阅读页。App 其他界面跟随系统深浅色。

**翻页动画**（设置项，默认「仿真」）

做法：翻页前把当前页截成位图（`View.draw` 到 Bitmap），WebView 跳到目标页，然后在 WebView 上方的覆盖层里对位图做动画，动画结束后移除覆盖层。往回翻时，先截当前页，再跳到上一页并截图，动画让上一页翻回来盖住当前页。

| 方式 | 点击触发 | 拖动 |
|---|---|---|
| 仿真 | 450ms 自动翻完 | 跟手。纸面用 `Canvas.drawBitmapMesh` 做卷曲，翻起部分的背面显示镜像的淡色内容，卷曲处和下层页面都有阴影；松手时按位置和速度决定翻过去还是退回 |
| 滑动 | 420ms，`cubic-bezier(.22,.8,.2,1)` | 跟手平移，松手判断同上 |
| 淡入 | 320ms 交叉淡化 | 不跟手，滑动距离超过 40dp 时触发 |
| 无 | 立即切换 | 同上 |

- 宽屏双页时，仿真以书脊为轴翻半屏：右页翻到左边。
- 第一页往前翻、最后一页往后翻时，页面轻微弹一下（320ms，14dp）。
- 系统开启「移除动画」（`ANIMATOR_DURATION_SCALE` 为 0）时一律按「无」处理。
- 动画期间保持 60fps，Systrace 里不能有连续掉帧；位图在动画结束后回收。

**阅读中查词**
- 长按单词 400ms 或双击单词时，用注入的 JS（`document.caretRangeFromPoint`）取出这个词和它所在的句子（以句号、问号、叹号为界，最多 400 字符），交给原生代码显示卡片（§3.2）。被查的词用 `r-hl` 色临时高亮，卡片关闭后去掉。
- 卡片先显示离线释义。如果配置了 Jev 且这个词有两个以上义项，再发一道 choice 题求本句义项（§5），结果按（原形，句子哈希）缓存。
- 收藏过的词在书里加点状下划线，所有变形都标出来。
- 菜单里的「查单词」打开一个输入框卡片，用法和查单词页相同。
- 「本书生词」：列出在这本书里收藏的词，点词跳到收藏时所在的位置。

### 3.6 生词本

- 大标题「生词本」，右上角「导出」。
- 筛选胶囊：全部、书库、查单词。「书库」指在阅读器里收藏的词，「查单词」指在查单词页和拍照结果里收藏的词。
- 按「刚刚、今天、昨天、更早」分组。每行显示：词，来源（书名、「查单词」或「拍照」），第一条释义。
- 紧凑：点词弹出卡片。宽屏：左右分栏，右侧显示释义。
- 左滑删除。
- 导出：写 CSV 到「下载/书边译-生词本-日期.csv」，用 MediaStore，不申请存储权限。列为：word, lemma, phonetic, meaning, context_sense, sentence, source, added_at。完成后显示提示条。

### 3.7 外部入口

| 入口 | 实现 |
|---|---|
| 系统选中菜单「书边译」 | `ACTION_PROCESS_TEXT`，只读 |
| 阅读 App 的外部词典 | ColorDict 协议：`colordict.intent.action.SEARCH`，读 `EXTRA_QUERY` |
| 下拉快捷设置磁贴 | `TileService`，点一下读剪贴板，查第一个英文单词；剪贴板里没有英文单词时打开查单词页 |
| 桌面图标长按 | 静态 shortcuts：「查单词」（打开首页并弹出键盘）、「拍一页」（直接打开系统相机） |
| 桌面小组件 | 一个搜索框样式的 2×1 小组件，点击打开查单词页并弹出键盘 |

前三个入口打开同一个透明主题的 `LookupActivity`，只显示词典卡片，下面的原 App 保持可见；点卡片外部或下拉关闭。选中的是多个词时：配置了翻译 Key 就走 §3.9 整句翻译，没配就查第一个词。这些入口拿不到句子，不显示「本句中」框。

### 3.8 设置

一个简单的列表页：

- Jev：Key 已内置，只保留「测试连接」按钮（发一道 noul 题，显示成功或错误信息）。
- 读者水平：多行文本，默认「Chinese native speaker reading English novels; passed CET-6 (about 6000 English words); comfortable with everyday and news vocabulary, weak on literary, archaic and nautical words.」。
- 整句翻译：接口地址（默认 `https://api.deepseek.com/v1`）、模型（默认 `deepseek-chat`）、Key。
- 音量键翻页：开关。
- 清除「认识」记录：需要确认。
- 关于：版本号、词典来源 ECDICT（MIT）、字体许可。

### 3.9 整句翻译与「问 AI」（最后做）

只在配置了翻译 Key 时出现。用 OpenAI Chat Completions 格式，流式（SSE）显示。系统提示：「把用户给出的英文译成自然的简体中文，只输出译文」。「问 AI」用于词典里查不到的词，把词和句子（有的话）发过去，请模型解释意思。

## 4. 词典数据

**来源**：[ECDICT](https://github.com/skywind3000/ECDICT)（MIT），用 `ecdict.csv` 和 `lemma.en.txt`。下载放在 `tools/cache/`，不提交到 Git。

**生成**：`tools/build_dict.py`，只用 Python 标准库，输出 `app/src/main/assets/dict.db`。生成的 db 提交到 Git，避免构建时还要下载。脚本打印词条数和文件大小。

收词规则：
- 按 `frq` 和 `bnc` 里较小的非零排名取前 60000 个词。
- 再加上带 `tag`（zk/gk/cet4/cet6/ky/toefl/ielts/gre）、`collins` > 0 或 `oxford` = 1 的词。
- 去掉含空格的词组、全大写的缩写和纯数字。

表结构：

```sql
CREATE TABLE entry (
  word TEXT PRIMARY KEY,   -- 小写
  phonetic TEXT,
  trans TEXT NOT NULL,     -- ECDICT translation，原样保留换行
  rank INTEGER             -- 词频排名，越小越常用；没有为 NULL
) WITHOUT ROWID;
CREATE TABLE form (
  form TEXT PRIMARY KEY,   -- 变形，小写
  lemma TEXT NOT NULL,
  kind TEXT NOT NULL       -- p 过去式, d 过去分词, i 现在分词, 3 三单, s 复数, r 比较级, t 最高级
) WITHOUT ROWID;
```

- `form` 表来自收入词条的 `exchange` 字段，加上 `lemma.en.txt`。变形本身也在 `entry` 里时，两个都保留：查询时先显示变形本身的词条，再显示原形。
- 词形还原规则只在查不到时兜底：去掉 -s/-es/-ed/-ing/-ly 再查。

**App 里**：首次启动时把 `dict.db` 从 assets 复制到 `databases/`，并记录版本号；版本变了重新复制。前缀查询用 `word >= ? AND word < ?` 走主键索引。

**义项拆分**（Jev choice 题的选项和「本句」标记都用它）：`trans` 按行拆，每行开头是词性（`n.`、`vt.` 等）；行内按「，」「,」「；」「;」拆成单个释义，去重，最多 12 个。

数据检查（写成单元测试，用真实的 `dict.db`）：
- `wharves` → `wharf`
- `hypos` → `hypo`
- `knocking` → `knock`
- `mole` 的释义里包含「防波堤」
- `spleen` 的释义里包含「忧郁」或「郁闷」

## 5. Jev 接口

- `POST https://api.typesafe.ai/v1/systemone`
- 请求头：`Authorization: Bearer <key>`、`Content-Type: application/json`
- 超时 20 秒，失败不重试，走离线兜底。

请求（2026-10-31 实测，模型 jev-1.14.0，16 道题耗时 1.1 秒）：

```json
{
  "model": "jev-latest",
  "state": { "reader": "<设置里的读者水平>", "passage": "<段落或句子>" },
  "questions": {
    "hard_spleen": {
      "type": "noul",
      "instructions": { "word": "spleen", "question": "Would this reader need to look up this word to understand it as used in the passage?" },
      "criteria": {
        "true": "The reader probably does not know this word, or does not know the sense it has in this passage.",
        "false": "The reader already knows this word in the sense used here."
      }
    },
    "sense_spleen": {
      "type": "choice",
      "instructions": "Which sense does 'spleen' have in this passage?",
      "criteria": { "脾，脾脏": null, "怒气，坏脾气": null, "郁闷，忧郁": null }
    }
  }
}
```

响应：

```json
{
  "model": "jev-1.14.0",
  "answers": {
    "hard_spleen": { "type": "noul", "noul": 0.78 },
    "sense_spleen": { "type": "choice", "choice": "郁闷，忧郁", "confidence": 0.82,
                      "probabilities": { "脾，脾脏": 0.01, "怒气，坏脾气": 0.11, "郁闷，忧郁": 0.88 } }
  },
  "usage": { }
}
```

- 题目 key 用 `hard_<lemma>`、`sense_<lemma>`。
- 把上面的响应样例存成 `app/src/test/resources/jev_response.json`，用来测试解析器。
- 实测参考（同一段《白鲸记》）：hypos 0.81、spleen 0.78、mole 0.77、insular 0.64；street 0.05、waves 0.07。可以拿 `testdata/` 里的书页照片对照。

## 6. 视觉规范

- **颜色**：只用 Radix Colors。App 界面用 slate 灰阶和 orange 强调色，跟随系统深浅色。

| 名称 | 浅色 | 深色 | Radix |
|---|---|---|---|
| bg | #fcfcfd | #111113 | slate1 |
| bg2 | #f9f9fb | #18191b | slate2 |
| fill | #f0f0f3 | #212225 | slate3 |
| fill2 | #e8e8ec | #272a2d | slate4 |
| line | #d9d9e0 | #363a3f | slate6 |
| faint | #8b8d98 | #696e77 | slate9 |
| muted | #60646c | #b0b4ba | slate11 |
| text | #1c2024 | #edeef0 | slate12 |
| accent | #f76b15 | #f76b15 | orange9 |
| accent-text | #cc4e00 | #ff801f | orange11 |
| accent-soft | #ffefd6 | #331e0b | orange3 |

- **字号**：只用 12、14、17、28sp 四种，靠字重和颜色区分层级。界面文字用系统字体；单词和书页用衬线体。
- **分隔线**：用 0.5dp 发丝线（`line` 色）。如果在 440dpi 上看不清，改用 1 个物理像素。
- **圆角**：嵌套元素的圆角要同心，内层半径 = 外层半径 − 内边距。不用卡片左侧彩色竖条，不加装饰性阴影；只有浮层（卡片、菜单、搜索框）用阴影。
- **文案**：不用「·」作分隔符，不加解释性小字，也不加小号的分类标题。
- **动画**：默认 250ms，缓动 `cubic-bezier(.2,.8,.2,1)`（ease-out）；只有 §3.1、§3.3、§3.4、§3.5 写明的动画可以用别的时长。系统关闭动画时全部跳过。

## 7. 性能目标

在关键路径打 `ShubianPerf` 标签的 logcat 日志（只记耗时，不记词以外的内容），用于验收：

| 指标 | 目标 |
|---|---|
| 冷启动到搜索框可输入（`am start -W` 的 TotalTime） | 真机 ≤ 500ms；模拟器仅作参考 |
| 前缀查询 | ≤ 10ms |
| 外部入口：从收到 intent 到卡片画出 | ≤ 250ms |
| 打开书：从点击到第一页可读 | ≤ 800ms（1MB 以内的 ePub） |
| 翻页动画 | 不掉帧 |
| release APK | ≤ 25MB；超出时说明原因（词典、字体、ML Kit 各占多少） |

## 8. 里程碑和验收

每个里程碑完成后，在 `docs/progress.md` 追加一段：做了什么、commit hash、§9 中对应命令的输出、与本文的偏差及原因。截图放 `docs/screens/M<n>/`，文件名写明外屏或内屏，以及浅色或深色。

| 里程碑 | 内容 |
|---|---|
| M1 | 工程骨架；词典生成和查询；查单词页（空闲和输入两种状态、FLIP 动画、内外屏）；词典卡片；朗读；`PROCESS_TEXT` 和 ColorDict 入口 |
| M2 | 生词本（分组、筛选、删除、导出 CSV）；设置页；磁贴、桌面快捷方式、小组件 |
| M3 | 书库；ePub 导入、解析和封面；阅读器的分页、主题、字体、字号、目录、书签、进度、双页；折叠和展开时保持阅读位置；长按查词；Jev 本句义项 |
| M4 | 四种翻页方式和打开、关闭书的动画 |
| M5 | 拍照找生词（ML Kit、粗筛、Jev 两步、离线兜底、结果页动画） |
| M6 | 整句翻译和「问 AI」 |

`testdata/` 需要准备：
- 公版 ePub：《白鲸记》EPUB3、《傲慢与偏见》EPUB2，从 Project Gutenberg 下载。
- 一张没有封面的 ePub：可以自己打包。
- 一张带 DRM 标记的假 ePub：在 `META-INF/encryption.xml` 里写一条加密记录。
- 一张《白鲸记》第一章的书页照片：可以把文字排版后截图，再用透视变换模拟拍摄角度。

## 9. 验收清单

Claude 按这份清单验收。能自动的部分请先自己跑通。

**构建和测试**

```
./gradlew clean testDebugUnitTest lintDebug assembleDebug assembleRelease
```

全部通过；lint 没有 error。

**模拟器设置**

```
emulator -avd Fold_DS_API36 &
adb install -r app/build/outputs/apk/release/app-release.apk
# 外屏尺寸
adb shell wm size 1168x1712 && adb shell wm density 440
# 内屏尺寸
adb shell wm size 2364x1672 && adb shell wm density 440
# 真实折叠和展开
adb emu fold
adb emu unfold
```

**功能检查**

1. 冷启动后在查单词页，键盘已弹出，搜索框居中。输入 `sp` 后搜索框上移，结果里有 `spleen`；清空后回到中间。外屏和内屏都检查。
2. 输入 `wharves`，第一行是 wharf，并注明「wharves 的复数」。
3. 外部入口：
   - `adb shell am start -a android.intent.action.PROCESS_TEXT -t text/plain --es android.intent.extra.PROCESS_TEXT hypos`
   - `adb shell am start -a colordict.intent.action.SEARCH --es EXTRA_QUERY mole`
   
   两条都应弹出透明卡片，释义正确。
4. 收藏 3 个词后，生词本里能看到，按来源筛选正确；导出的 CSV 在「下载」目录里，列完整。
5. 导入 `testdata/` 的两本书。
   - 封面显示正确，无封面的书显示生成封面；DRM 书提示无法打开；同一本书第二次导入提示「已在书库」。
   - 打开《白鲸记》，翻到第 5 页后折叠再展开，仍在同一段落。改字号后也在同一段落。
6. 阅读器里长按 `spleen`：卡片出现，没有挡住这个词；配置 Jev 后「本句中」显示「郁闷，忧郁」。收藏后，书里这个词有点状下划线。
7. 四种翻页方式逐一切换，点击翻页和拖动翻页都试，录屏检查；仿真模式在双页下以书脊为轴。系统关闭动画后翻页没有动画。
8. 拍照找生词：
   - 用 `testdata` 的书页照片走「从相册选」，生词包含 hypos、spleen、mole，不包含 street、waves。
   - 断网再试，走离线兜底。
9. `adb logcat -s ShubianPerf` 中的耗时符合 §7；记录 APK 体积。
10. 全局检查：
    - `grep -rn "TYPESAFE\|Bearer [A-Za-z0-9]" app/ tools/` 没有真实 Key。
    - 界面没有「·」。
    - 字号只有 4 种。
    - 深色模式下各页面可读。

**需要真机确认（不阻塞交付）**：国行系统上 ML Kit 能否离线识别；手机网络能否访问 `api.typesafe.ai`；实际 dp 尺寸和密度；HyperOS 上 `PROCESS_TEXT` 菜单是否显示「书边译」。

## 10. 首版不做

PDF 和 mobi；DRM 书；云同步、多设备；整页翻译；同步到背单词 App；书内全文搜索；批注和高亮笔记（书签除外）；EPUB 固定版式（fixed layout）。
