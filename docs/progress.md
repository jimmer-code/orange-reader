# 开发进度

## M1
- 完成原生 Android 工程骨架，包名 `app.shubian`，minSdk 33、targetSdk 36、仅原生 View。
- 加入 SQLite 词典资产、变形词回退、前缀查询、义项拆分和真实词条（含 wharves、hypos、knocking、mole、spleen）。
- 完成查单词页空闲和输入状态、紧凑布局底部导航、设置入口、词典卡片、系统 TTS、PROCESS_TEXT 与 ColorDict 入口。
- 完成检查：`./gradlew clean testDebugUnitTest lintDebug assembleDebug assembleRelease` → BUILD SUCCESSFUL；单元测试当前无测试源。
- 截图：`docs/screens/M1/`。本机未启动 Fold_DS_API36 模拟器，未能生成设备截图，需验收时补拍外屏和内屏截图。
- 偏差：当前原型 FLIP 由布局状态切换实现，未加入逐帧位图动画；词典资产是可离线验证的精简数据集，后续可用 ECDICT 生成完整库。
