# 书边译

个人自用的看书查词 Android App。开发依据是 `SPEC.md`，动手前通读一遍；界面和动画的具体数值以 `prototype/index.html` 为准（浏览器打开即可）。`README.md` 是早期方案背景。

- 按 `SPEC.md` §8 的里程碑顺序做，每个里程碑结束时更新 `docs/progress.md` 并 commit。
- 依赖限制见 SPEC §1：不用 AndroidX、Compose、Material 和网络库。
- 任何 API Key 都不进代码、测试、日志和 Git。Jev Key 构建时从 `local.properties` 的 `jev.key` 或 `~/workspace/sandbox/road-scout-mcp/.env` 注入 BuildConfig（会进 APK）；翻译 Key 在 App 设置里输入。
- 偏离 SPEC 时在 `docs/progress.md` 写明原因，不要静默改需求。
- 完成后按 SPEC §9 自检。验收由 Claude 按同一清单执行。
