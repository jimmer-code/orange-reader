# 状态机清单

书边译的界面是一个 WebView，但它同时承载查词、阅读器、课程、扫描、分享和多个原生异步请求。过去这些流程主要由布尔值、DOM class、对象是否为 `null` 和回调时序共同决定，状态存在却没有统一的转移规则。

本次整理采用**正交状态机**：互不排斥的流程保持独立，不把整个 App 塞进一个组合爆炸的“大状态机”。运行时实现位于 `app/src/main/assets/web/state.js`，不引入框架或 Android 依赖。

## 运行时状态机

| 机器 | 状态 | 事件/转移 | 不变量 |
|---|---|---|---|
| `tab` | `physical`、`library`、`kb`、`words` | `set(tab)` | 只有四个主标签；非法标签被忽略 |
| `lookup` | `idle`、`querying`、`selected` | `query`、`select`、`clear` | 输入、选词和清空不会互相遗留；切换标签清掉选词 |
| `sheet` | `closed`、`open` | `open`、`close` | 页面最多有一个底部卡片；换卡片仍是同一条打开状态 |
| `sheet-gesture` | `idle`、`dragging` | `start`、`move`、`release`、`cancel` | 下拉关闭只在当前拖动手势里生效，不会把滚动或按钮点击当成关闭 |
| `import` | `idle`、`selecting`、`importing`、`error` | `choose`、`start`、`done`、`fail`、`cancel` | 文件选择器和解析结果有明确边界；旧选择器结果不能覆盖新选择 |
| `reader` | `closed`、`opening`、`ready`、`turning`、`closing`、`error` | `open`、`ready`、`turn`、`close`、`closed`、`error` | 打开/关闭/翻页互斥；加载失败会回到可重试的关闭状态 |
| `reader-gesture` | `idle`、`pressed`、`feedback`、`locked`、`selecting` | `press`、`feedback`、`lock`、`select`、`release`、`cancel` | 长按反馈、锁词和拖选的阶段不会靠计时器猜测 |
| `words-gesture` | `idle`、`pressed`、`swiping`、`removing` | `press`、`swipe`、`move`、`remove`、`release`、`cancel`、`done` | 左滑删除的位移、删除动画和列表重绘有明确边界 |
| `kb-view` | `courses`、`list`、`read` | `set(view)` | 课程列表、文章列表和文章阅读不会靠多个布尔值互相覆盖 |
| `kb-sync` | `idle`、`syncing`、`error` | `start`、`progress`、`done`、`fail` | 同一时刻最多一次同步；失败只显示缓存并可重试 |
| `kb-article` | `idle`、`loading`、`ready`、`error` | `load`、`ready`、`error`、`cancel` | 文章挂载键和状态一致；旧文章的成功、失败和清理回调都会被丢弃 |
| `scan` | `closed`、`requesting`、`recognizing`、`judging`、`results`、`error` | `request`、`image`、`judge`、`results`、`error`、`cancel` | 旧 OCR/Jev 回调不能覆盖新照片的结果 |
| `update` | `idle`、`checking`、`available`、`downloading`、`permission`、`ready`、`error` | `check`、`available`、`current`、`download`、`permission`、`ready`、`error` | 清单、下载、安装器权限和系统安装器的反馈按同一请求 ID 归属 |
| `excerpt` | `idle`、`generating`、`preview`、`sharing`、`error` | `generate`、`open`、`share`、`cancel`、`error` | 取消或换卡片后，迟到的译文和图片生成结果不回写预览 |
| `viewer` | `closed`、`open` | `open`、`close` | 图片和 Mermaid 共用一个查看器，不会重复挂载两层查看器 |
| `viewer-gesture` | `idle`、`pressed`、`moving`、`pinching` | `press`、`move`、`pinch`、`release`、`cancel` | 拖动、双指缩放和点击关闭不会互相误触 |

`sheet` 还有一条 request gate。每次打开或关闭卡片都会换 token，设置页的 Jev 测试完成后只有在 token 仍然有效、按钮仍连接在文档中时才更新文字。这避免了用户关掉设置或换到另一张卡片后，旧请求回写新界面。

导入、扫描、更新、课程文章和书摘生成也各自持有 monotonic request gate。原生桥把导入/相机/相册/更新的请求 ID 原样带回，WebView 在改变 DOM 前同时检查状态和 ID；因此“重拍”“重试”“重新检查”不需要等待旧线程自然结束。`state.js` 的 `request()` 是这个边界的无框架实现，快照只暴露数字 ID，不暴露文件路径、文本或密钥。

课程文章的加载继续使用文章键（课程、文章、更新时间）作为挂载代数。成功和失败分支都检查这个键；因此旧文章的网络错误不会覆盖用户已经打开的新文章。

## 已识别的隐式状态

以下状态仍然是**局部、派生或每请求独有**的变量，不适合提升为全局机器，但已记录为明确的契约，便于维护和自动化检查：

- 查词：空闲 → 输入前缀 → 选中词；外屏表现为卡片，内屏表现为左右栏。`query` 和 `pick` 是这条机器的两个正交维度。
- 阅读手势：空闲 → 按下/预按 → 锁定单词 → 拖选 → 完成或取消。手势只存在于当前阅读器实例，不能跨页复用。
- 词卡语境义：离线释义 → Jev 请求中 → 命中义项/隐藏语境框。节点连接性检查是它的取消条件。
- 翻译流：未请求 → SSE 增量 → 完成/错误/超时；每个 `trWait[id]` 都有独立的请求机，同一段文字由内存缓存复用，超时后迟到的增量会被丢弃。
- Jev 请求：未请求 → 等待 → 成功/失败；每个 `jevWait[id]` 都有独立的请求机。
- 扫描内部步骤：系统相机/相册等待 → 图片已到达 → OCR → 难度判断 → 结果；没有网络时结果仍是 `results`，但带 `offline` 标记。
- 书库导入：选择文件 → 原生复制/解析 → 成功或错误；导入中的书用 `importing` 视觉标记，完成后再刷新网格。
- 在线更新：空闲 → 检查 → 有更新/已是最新/错误 → 下载 → 权限/安装器已打开。按钮的 `data-update-state` 是当前 UI 投影。
- 分页：当前章已排版 → 失效 → 后台测量 → 缓存命中/重新显示。`measureToken` 防止旧测量结果写回新书或新字号。
- 课程阅读工具栏：显示/隐藏、普通/沉浸是两个正交轴；滚动累计超过阈值才切换，避免一滚一抖。
- 媒体查看器手势：静止 → 拖动或捏合 → 释放；`viewer` 机器负责查看器生命周期，`KBV.open` 只是兼容渲染代码的镜像字段，缩放和旋转保留在局部手势状态。
- 原生宿主：页面加载中/已就绪、TTS 初始化/可用/失败、Activity 存活/销毁、相机或文件选择结果等待。这些状态由 `WebActivity` 和 Android 系统持有，页面通过带请求 ID 的桥接事件观察；宿主生命周期仍不伪装成页面状态。
- 屏幕适配：外屏/内屏，以及横屏/竖屏，是布局条件，不是业务导航状态；折叠时只重新布局并恢复阅读比例或字符锚点。

## 对体验和维护的约束

1. 卡片、阅读器、扫描和查看器是互斥的视觉层；返回键按查看器 → 卡片 → 扫描 → 阅读器 → 标签页的顺序退出。
2. 所有跨异步边界的结果必须带请求 ID、挂载键或 gate token；没有它就不能直接写 DOM。
3. “离线”是结果状态，不是失败的空白页。扫描和课程都保留已有内容，并把重试作为显式事件。
4. 状态机只负责允许/拒绝转移，现有渲染函数继续负责 DOM 和动画。这样既不改变原型数值，也方便代理在不运行完整 Android 环境时检查状态。

## 给自动化和 Agent 的观察面

页面会同步暴露一个无敏感数据的快照：`window.__SHUBIAN_STATE__`，并把同一份 JSON 写入根元素的 `data-shubian-state`。底部卡片和扫描层还分别带有 `data-state`。自动化应先读取这些状态，再执行点击或返回操作，避免只根据动画中的 class 猜测当前页面。

## 验证清单

- `node --check app/src/main/assets/web/state.js`
- `node --check app/src/main/assets/web/app.js`
- `./gradlew testDebugUnitTest lintDebug assembleRelease`
- 课程：快速切换两篇文章，旧文章失败不能覆盖新文章。
- 设置：点“测试连接”后立即关闭并打开另一张卡片，旧结果不能改写新卡片。
- 扫描：重拍后旧 OCR/Jev 结果不能出现在新照片。
- 阅读：翻页动画中重复点按、按返回键，不能产生并行翻页或半关闭阅读器。
