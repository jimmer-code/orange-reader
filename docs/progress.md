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
