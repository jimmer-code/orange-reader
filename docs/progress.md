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
  - Jev Key 按用户要求在构建时从 `local.properties` 的 `jev.key` 或 `~/workspace/sandbox/road-scout-mcp/.env` 注入 `BuildConfig`，会进入 APK，但不进 Git；设置页不再要求填写。
  - Typesafe 对中国大陆返回 HTTP 451，手机需代理或 VPN 才能用 Jev；否则走离线词频判断。
  - 前缀查询按词频排序，`sp` 首屏是 speak、spend 等常用词，不再包含 spleen。
  - 「原色」「粗体」主题在系统深色模式下改用深色底。
