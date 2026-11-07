# 课程板块验收清单

## P1 同步与托管

- [ ] `tools/notion-sync` 在 fixtures 模式下产出 dist，`verify` PASS（无 token）。
- [ ] Notion internal connection 建好，capabilities 只有 Read content，只分享知识库根页。
- [ ] `~/.config/shubian-kb/env` 600；`git status` 里没有 token/secret。
- [ ] 真实全量同步：68 篇（CS2680 12、Berkeley 12、量化 43、架构 1）；待发布/综合/模板页被过滤。
- [ ] 图片本地转存 WebP，无 Notion 域名/签名 URL；mermaid 全部内联 SVG 或有源码 fallback。
- [ ] VPS `/var/www/shubian-kb/<secret>/index.json` 200；错误 secret 404。
- [ ] 缓存头：index/status `no-store`；media/releases immutable；`X-Robots-Tag: noindex`。
- [ ] 改一篇 Notion（加一行字）→ 30 分钟内 index 的 release 变化，对应文章更新。
- [ ] 失败演练：断网跑一轮 → 旧 index 不变，日志有错误，App 仍可读。
- [ ] launchd 已安装；Kuma 心跳正常；ops-hub 登记并 `ops docs` 通过。
- [ ] 回滚演练：`index-<旧>.json` 覆盖 index 后 App 回到旧版。

## P2 App

- [ ] `node --check app/src/main/assets/web/app.js`；`./gradlew clean testDebugUnitTest lintDebug assembleDebug assembleRelease` 通过；APK ≤ SPEC §7 限制。
- [ ] 外屏 1168×1712：第 4 个标签出现；课程列表 4 门课；进入文章列表；打开文章可滚动阅读。
- [ ] 内屏 2364×1672：左列表右文章；导航不挤；切换文章正常。
- [ ] 折叠/展开：外屏读到中部 → 展开 → 位置不丢；返回列表/返回查单词层级正确。
- [ ] 图片：正文图正常显示（本地 /kb/），点击可看大图；表格可横向滚动；代码块可横向滚动。
- [ ] mermaid：流程图以 SVG 显示、宽度不溢出；深浅两套主题下都可读。
- [ ] 主题/字号/行距在阅读页生效；与书阅读器设置互不影响或共用（按实现）。
- [ ] 断网重开 App：已同步内容可读，显示「离线 · 显示缓存」；恢复网络刷新成功。
- [ ] 同步中断（点取消/杀进程）：旧内容可读，index 没被写坏。
- [ ] 空缓存首次进入：显示空态 + 同步按钮；同步进度可见；完成后列表出现。
- [ ] 阅读进度：退出再进回到原位置；「继续阅读」卡正确。
- [ ] 内链：文章间跳转正确；外链用系统浏览器打开。
- [ ] 缓存清理：设置里可清课程缓存，阅读进度保留。
