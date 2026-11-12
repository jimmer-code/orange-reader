# Orange Reader

一个离线优先的 Android ePub 阅读器，支持查词、拍照识词、生词本和可选的自定义 AI 翻译。

[![Latest release](https://img.shields.io/github/v/release/jimmer-code/orange-reader?display_name=tag&sort=semver)](https://github.com/jimmer-code/orange-reader/releases)
[![Android](https://img.shields.io/badge/Android-13%2B-3ddc84?logo=android&logoColor=white)](https://developer.android.com/about/versions/13)

## 下载

[下载最新版本](https://github.com/jimmer-code/orange-reader/releases/latest)

- Android 13 及以上
- `arm64-v8a`
- 公开版通过 GitHub Releases 发布

## 功能

- **离线查词**：ECDICT 词典、词形还原、音标和系统朗读
- **ePub 阅读**：导入 ePub，支持分页、主题、字号、书签和阅读进度
- **拍照识词**：拍照或从相册选择书页，识别其中的生词
- **生词本**：收藏词汇，按来源筛选并导出 CSV
- **折叠屏适配**：小屏单栏，宽屏支持双页阅读
- **可选 AI**：使用自己的 DeepSeek API 做整句翻译，或使用 Jev 判断语境义

公开版不包含课程模块，也不内置任何 API Key。不配置 AI 时，离线查词、阅读、拍照识词和生词本仍可正常使用。

## AI 配置

在应用设置页填写自己的 Key。两个服务都默认由用户自行开通和计费。

| 功能 | 服务 | 模型 | 默认状态 |
| --- | --- | --- | --- |
| 整句翻译 | 官方 DeepSeek API | `deepseek-flash`（DeepSeek V4.1 Flash） | 关闭 |
| 语境判断 | OpenRouter | `jev-latest` | 关闭 |

Key 使用 Android Keystore 加密后保存在本机，不写入仓库、日志或 WebView 数据。启用 AI 后，选中的文本或上下文会直接发送给对应服务商。

## 从源码构建

需要 Android SDK 36 和 JDK 21。公开版构建命令如下：

```bash
./gradlew assemblePublicEdition
```

APK 输出在：

```text
app/build/outputs/apk/publicEdition/app-publicEdition.apk
```

运行检查：

```bash
./gradlew testDebugUnitTest lintDebug
```

## 项目文档

- [`SPEC.md`](SPEC.md)  工程规格和验收清单
- [`prototype/index.html`](prototype/index.html)  界面与交互原型
- [`docs/progress.md`](docs/progress.md)  里程碑、发布记录和已知偏差

## 致谢

- [ECDICT](https://github.com/skywind3000/ECDICT)，MIT License
- [Literata](https://github.com/googlefonts/literata) 和 [Source Serif 4](https://github.com/adobe-fonts/source-serif)，SIL Open Font License
