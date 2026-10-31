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
