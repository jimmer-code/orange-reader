# 开发进度

## M1
- 完成原生 Android 工程骨架，包名 `app.shubian`，minSdk 33、targetSdk 36、仅原生 View。
- 加入 SQLite 词典资产、变形词回退、前缀查询、义项拆分和真实词条（含 wharves、hypos、knocking、mole、spleen）。
- 完成查单词页空闲和输入状态、紧凑布局底部导航、设置入口、词典卡片、系统 TTS、PROCESS_TEXT 与 ColorDict 入口。
- 完成检查：`./gradlew clean testDebugUnitTest lintDebug assembleDebug assembleRelease` → BUILD SUCCESSFUL；单元测试当前无测试源。
- 截图：`docs/screens/M1/`。本机未启动 Fold_DS_API36 模拟器，未能生成设备截图，需验收时补拍外屏和内屏截图。
- 偏差：当前原型 FLIP 由布局状态切换实现，未加入逐帧位图动画；词典资产是可离线验证的精简数据集，后续可用 ECDICT 生成完整库。

## M2
- 生词本支持收藏持久化、按来源筛选胶囊、分组列表基础展示、滑动删除预留、MediaStore CSV 导出（完整列头）。
- 设置页加入 Jev Key、读者水平、整句翻译地址模型和 Key 的私有 SharedPreferences 输入，Key 不进入代码、日志或 Git；加入测试连接反馈、音量键开关、认识记录清除入口和关于信息。
- 加入 Quick Settings Tile、静态桌面快捷方式和 2×1 搜索小组件。
- 检查：`./gradlew clean testDebugUnitTest lintDebug assembleDebug assembleRelease` → BUILD SUCCESSFUL。
- 截图：`docs/screens/M2/`；当前未运行模拟器，未生成设备截图。
- 偏差：生词按来源的持久化字段尚未拆成独立 SQLite 表，当前用私有偏好保存词和释义；后续书库接入时迁移到统一数据层。

## M3
- 书库支持 ACTION_OPEN_DOCUMENT 选择 EPUB，复制到 `files/books/<sha1>.epub` 并持久化书名作者与阅读状态；重复导入复用同一 SHA-1 文件。
- 加入阅读器页面、长按查词、阅读工具栏（目录、字号、主题、字体、书签入口）和基础进度显示；折叠配置通过主 Activity 的 configChanges 保留当前页面。
- 检查：`./gradlew clean testDebugUnitTest lintDebug assembleDebug assembleRelease` → BUILD SUCCESSFUL。
- 截图：`docs/screens/M3/`；未运行模拟器，未生成设备截图。
- 偏差：当前阅读器使用可读的原生文本占位页，尚未完成 ZIP 内 OPF/nav/XHTML 解析、WebView 资源拦截、真实多栏分页和双页模式；这些在后续迭代继续补齐。

## M4
- 阅读页增加四种翻页方式的可切换动画路径：仿真（轻微卷页感）、滑动、淡入和无动画；读取系统 `ANIMATOR_DURATION_SCALE`，系统关闭动画时直接切换。
- 主题选择结果保存到设置，阅读工具栏保留目录、字号、字体、书签入口。
- 检查：`./gradlew clean testDebugUnitTest lintDebug assembleDebug assembleRelease` → BUILD SUCCESSFUL。
- 截图：`docs/screens/M4/`；未运行模拟器，未生成设备截图。
- 偏差：仿真动画当前用原生 View 的轻微旋转代替位图 mesh 卷曲，拖动跟手和双页书脊轴尚未实现。

## M5
- 拍照和相册入口进入结果页，显示照片预览、识别状态、一次扫描线反馈和错开淡入的候选词列表。
- 离线结果明确提示“离线判断，可能不准”，候选包含 hypos、spleen、mole；长按“认识”会持久化并移除该词，点击候选可打开共用词典卡片。
- 加入 `testdata/` 最小 EPUB3、EPUB2 夹具和带 `META-INF/encryption.xml` 的 DRM 假书，方便验收导入与拒绝路径。
- 检查：`./gradlew clean testDebugUnitTest lintDebug assembleDebug assembleRelease` → BUILD SUCCESSFUL；debug APK 2.4 MB，release APK 52 KB（R8/资源压缩后，已用本机 debug keystore 签名）。
- 截图：`docs/screens/M5/`；未运行模拟器，未生成设备截图。
- 偏差：此环境没有接入 ML Kit 内置模型依赖，M5 当前以离线候选和扫描流程占位；Jev 两步请求与 OCR 实际识别需后续接入依赖和 API。

## M6 按原型重做
- 界面改为一个全屏 WebView 加载 `assets/web/`（原型的 HTML/CSS/JS 直接移植），原生 Java 通过 `window.Native` 提供词典、EPUB、OCR、TTS、Jev、导出等能力；书内资源经 `https://app.local/book/<id>/…` 从 zip 直接读取。
- 词典：`tools/build_dict.py` 从 ECDICT 生成 57,183 词条、50,077 个变形（5.3 MB），`tools/supplement.tsv` 补 spleen/hypo 的旧义。
- 阅读器：CSS 多栏分页，按（章节，字符偏移）记位置，后台测全书页数；目录锚点决定页眉章名；长按或双击查词，收藏词加虚线；外屏单页、内屏双页，展开折叠保持位置；仿真、滑动、淡入、无四种翻页，系统关闭动画时直接切换。
- 出版社 CSS 整体丢弃，只保留图片的百分比宽度（避免章首花饰被拉满整栏）。
- 拍照查词：ML Kit 内置模型识别，过滤专名、常见词和已认识词，再用 Jev 两步判断（noul 选难词，choice 选本句义项）；无网络时按词频给前 20 个。
- 实测书目：Moby Dick、Pride and Prejudice、`~/workspace/读书` 中的 The Status Game、Reset、The Infinity Machine、The Secrets We Kept、Dune 六部合集（341 个 spine 文件）。
- 检查：`./gradlew clean testDebugUnitTest lintDebug assembleDebug assembleRelease` → BUILD SUCCESSFUL；debug APK 28 MB，release APK 19 MB（ML Kit 模型约占 15 MB，仅 arm64-v8a）。
- 截图：`docs/screens/M6/`（Fold_DS_API36 模拟器，外屏 1168×1712、内屏 2364×1672）。
- 偏差：
  - 界面用 WebView 而不是原生 View，语言是 Java 而不是 Kotlin。原因：与原型像素和交互一致，且原型代码可直接复用。
  - OpenCode Key 按用户要求在构建时从 `local.properties` 的 `opencode.key`（OpenCode Go 账号）注入 `BuildConfig`，Jev 和翻译共用，会进入 APK，但不进 Git；设置页不再要求填写。
  - Jev 改走 OpenCode Zen（`opencode.ai/zen/v1/systemone`，模型 jev-1.13-free，限时免费），不再直连 Typesafe（对中国大陆返回 HTTP 451）。
  - 前缀查询按词频排序，`sp` 首屏是 speak、spend 等常用词，不再包含 spleen。
  - 「原色」「粗体」主题在系统深色模式下改用深色底。

## M7 阅读排版
参照 ReadiumCSS（Readium 阅读器的样式规范）、Apple Books、Kindle 和 KOReader 的做法改进阅读页。
- 保留原书样式：加载原书的 CSS，去掉与阅读设置冲突的属性（字体、颜色、背景、行高、定位、高度、分栏），px/pt 字号换成 em，body 上的字号和边距不用；`justify`/`left` 对齐改由阅读设置决定，居中和右对齐保留；纸书分页 `page-break-*` 换成分栏。每个样式表只作用于引用它的章节（合集各卷样式不同）。内置默认样式放在 `:where()` 里，原书写了的属性以原书为准。
- 排版：用户行距强制作用于正文段落；`hyphenate-limit-chars`、`text-wrap: pretty`、标题 `balance`、孤行寡行各 2 行、上下标不撑开行距；单页时行长上限约 34em。
- 新设置：行距（紧凑、适中、宽松）、页边距（窄、中、宽）、两端对齐、原书排版。关掉原书排版回到 M6 的统一样式。
- 图片：只有一张图的页（封面、插图）单独占一页并垂直居中；线稿（花饰、地图）浅色主题融进底色，深色主题反相，照片压暗。
- 链接与注释：书内链接可点击跳转，跳转后底部出现「返回原处」（翻 3 页后消失）；注释链接（`doc-noteref`、`epub:type="noteref"`、上标数字）点开浮层，不离开当前页；`aside` 脚注在正文中隐藏。
- 目录去掉 Gutenberg 写入的纸书页码条目（如 `{32}`）。
- 实测：Dune 合集（题记居中缩排、6,970 页，后台分页 3.5 秒）、The Secrets We Kept（章首花饰）、The Infinity Machine（尾注浮层，真机触摸事件测试）、The Status Game（Calibre 转换、目录链接跳转）、Moby Dick 内屏双页、Pride and Prejudice。
- 检查：`./gradlew clean testDebugUnitTest lintDebug assembleDebug assembleRelease` → BUILD SUCCESSFUL，release APK 19 MB。
- 截图：`docs/screens/M7/`。

## M8 整句翻译
- 翻译和「问 AI」改走 OpenCode Go 的 DeepSeek V4.1 Flash，用内置的 OpenCode Key，设置页去掉接口地址、模型、Key 三项。请求带 `x-opencode-session`，关闭思考（首字从约 3 秒降到约 2 秒）。
- 阅读页整句翻译两个入口：长按查词后不松手拖动扩选，松手翻译选区（选区用 CSS Highlight API 高亮，不改 DOM）；查词卡「翻译整句」翻译当前句。
- 实测：模拟器内屏双页 Moby Dick 第 20 章，`adb input motionevent` 长按拖动两行，译文流式显示；「翻译整句」翻译 might 所在的整句。
- 第二轮：拖选可以跨页（拖到左右边缘停住翻页）；翻译 prompt 参照沉浸式翻译 ebook/fiction 专家并加反翻译腔规则，带书名和段落上下文；连接复用和预热后，手机上 Jev 从 1.3 到 4.6 秒降到约 0.5 秒，翻译首字 1.2 到 1.5 秒；同句译文缓存。

## M9 词、短语、句子统一选区（commit 1529d27）
- 阅读器按住流程改为状态机：130ms 按住反馈、360ms 锁定起始词，继续移动才进入选区；使用 `setPointerCapture()`，卡片延迟到松手后显示，避免拖动时被卡片层打断。
- 选区按英文 token 吸附，松手后自动区分词、短语和句子；卡片提供“词 / 短语 / 句子”切换。词继续走离线词典和 Jev 本句义，短语走选区翻译并可保存，句子走整句翻译并可保存摘录。
- 边缘选区保留 450ms 首次停留和 900ms 连续翻页，增加边缘遮罩和 250ms 过渡；选区跨同一章节分页时保持高亮。
- 新增轻触觉反馈 Bridge；短语和句子分别保存到 `savedPhrases`、`savedQuotes`，不混入生词本。
- 检查：`node --check app/src/main/assets/web/app.js && ./gradlew clean testDebugUnitTest lintDebug assembleDebug assembleRelease` → BUILD SUCCESSFUL；模拟器验证词卡、短语选区卡片、层级切换和流式翻译，无新增 WebView 异常。
- 截图：`docs/screens/M9/`（Fold_DS_API36 内屏，浅色词卡和短语卡）。
- 偏差：当前未做跨章节选区；句子层级使用起始词所在句作为上下文，跨句拖动仍保留在当前章节内，后续再扩展句间选择。

## M10 连续翻页交互
- 翻页请求改为队列：动画进行时继续滑动不会丢失，后续方向按顺序消费，最多缓存 12 次手势。
- 连续翻页使用加速过渡：仿真翻页从 720ms 调整为规格中的 450ms，队列中的仿真页缩短为 280ms；滑动和淡入也有快速连续模式；“无”保持立即切换。
- 关闭图书或重新打开图书时清空待处理翻页，避免旧手势进入新书。
- 检查：`node --check app/src/main/assets/web/app.js && ./gradlew testDebugUnitTest lintDebug assembleDebug assembleRelease` → BUILD SUCCESSFUL。
- 偏差：本轮采用可连续消费的翻页队列，尚未实现手指直接拖拽页面曲面的完全跟手中断；仿真翻页仍在每页动画之间快速衔接。

## M11 在线更新
- Commit：`da19c46`。
- 设置页新增「在线更新」入口。点击后从 `https://update.lemonation.cloud/shubian-translate/latest.json` 检查版本；清单限定 HTTPS、域名和路径，并校验版本号、文件大小和 SHA-256。
- 新版本下载到应用私有外部目录，下载完成后通过自定义 `UpdateProvider` 提供 `content://` URI，交给 Android 系统安装器完成覆盖安装；没有安装未知应用权限时引导到系统设置。
- 版本升到 1.2 / versionCode 3。复用 Fold DS 的更新站点，在 `/shubian-translate/` 下独立保存清单和最近两个 APK；发布脚本为 `tools/publish_update.sh`。线上 1.2 APK 已核对大小和 SHA-256。
- 检查：`node --check app/src/main/assets/web/app.js && bash -n tools/publish_update.sh && /Users/jimmymacmini/ops-hub/bin/ops docs && ./gradlew clean testDebugUnitTest lintDebug assembleDebug assembleRelease` → BUILD SUCCESSFUL；`apksigner verify` 和 `zipalign -c -P 16 4` 通过；线上清单与本地 release APK 大小和 SHA-256 一致。
- 偏差：在线更新是本次新增需求，不在原 M1 到 M6 里程碑内；当前没有连接 Fold_DS_API36 或实体设备，因此系统安装器的最后一步未做设备实测，下载、校验和清单端到端已在本机与线上节点核对。

## M12 阅读器方向适配
- Commit：`c0f998d`。
- 双页布局改为只在宽屏横屏生效。宽屏竖屏强制单页，旋转回横屏后恢复原来的双页开关；外屏原有单页行为不变。
- 版本升到 1.3 / versionCode 4。规则按窗口宽高和 600dp 断点判断，不按设备型号判断，因此小米 18 Fold 内屏和小米 K Pad 都能在横屏双页、竖屏单页之间自动切换。
- 检查：`node --check app/src/main/assets/web/app.js`，并复用本轮 Gradle 构建检查；设备截图待 Fold_DS_API36 或小米 K Pad 连接后按 §9 补拍。

## M13 离线词汇与短语覆盖
- Commit：`5927745`。
- 审计结果：原词库有 58,068 个核心词条和 50,082 个变形，ECDICT 中有词频的数据基本已覆盖；原构建脚本完全排除了多词短语。
- 词库改为核心 SQLite 加压缩长尾资产。当前离线支持 58,068 个核心词条、约 138,000 个额外短词条、约 151,900 条短语，并保留 50,082 个核心变形。长尾资产首次启动时导入应用私有 SQLite，后续查询仍是本地 SQLite。
- 阅读器选中的短语先查本地词库，命中时直接显示离线释义，查不到才使用整句翻译；查词页输入带空格的短语也能给出本地候选。
- 版本升到 1.4 / versionCode 5。release APK 仍控制在 25 MB 内。
- 检查：`python3 tools/build_dict.py && node --check app/src/main/assets/web/app.js && ./gradlew testDebugUnitTest lintDebug assembleDebug assembleRelease` → BUILD SUCCESSFUL；词库构建断言通过，release APK 体积 24,901,621 bytes。

## M14 长单词跨行取词
- Commit：`e9523da`。
- 修复阅读器长按跨行单词时可能命中前一个词的问题。取词现在检查触点附近候选词各自的字符矩形，不再使用跨行后的联合矩形。
- 版本升到 1.5 / versionCode 6。
- 检查：`node --check app/src/main/assets/web/app.js && ./gradlew testDebugUnitTest lintDebug assembleDebug assembleRelease` → BUILD SUCCESSFUL。
