# Orange Reader

Orange Reader 的 Android 阅读与查词工具。它把离线词典、ePub 阅读器、生词本和可选的自定义 AI 翻译放在一个应用里，适配小屏和折叠屏。

## 公开版功能

- ECDICT 离线查词、词形还原、音标和系统朗读
- ePub 导入、分页阅读、主题、字号、书签和阅读进度
- 拍照或从相册识别页面中的生词
- 生词本和 CSV 导出
- 可选的整句翻译
- 可选的 Jev 语境判断

公开版不包含课程入口，也不内置任何 API Key。应用设置页可以填写自己的服务商 Key。

## AI 配置

- DeepSeek 使用官方 API，界面名称为 DeepSeek V4.1 Flash，模型 ID 为 `deepseek-flash`
- Jev 使用自己的 OpenRouter API Key，默认关闭
- 没有 Key 时仍可使用离线查词、阅读、拍照识词和生词本

Key 保存在 Android Keystore 中，不写入仓库、日志或 WebView 数据。

## 获取 APK

公开版通过 GitHub Releases 发布

<https://github.com/jimmer-code/orange-reader/releases>

## 本地构建

```bash
./gradlew assemblePublicEdition
```

APK 输出在 `app/build/outputs/apk/publicEdition/app-publicEdition.apk`。

## 开发文档

- `SPEC.md` 是工程规格和验收清单
- `prototype/index.html` 是界面与交互原型
- `docs/progress.md` 记录里程碑和已知偏差

## 项目状态

公开版持续维护中。当前发布版本会以 GitHub Release 的说明为准。
