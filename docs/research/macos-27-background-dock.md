# macOS 27「Golden Gate」后台运行指示与 Dock 图标调研

> 调研日期：2026-09-16（macOS 27 正式发布后第 2 天）
> 背景：Clash Party 的轻量模式（`quitWithoutCore()`，见 `src/main/core/manager.ts`）目前调用 `app.exit()` 让 Electron 主进程完全退出，仅留下 detached 的 setuid-root mihomo 核心进程在后台无界面运行。用户系统为 macOS 26 Tahoe（darwin 25.6），开启台前调度（Stage Manager），并使用 `useDockIcon=false`。本调研回答：macOS 26/27 上能否让应用在 Dock 保留图标并显示"正在后台运行"。
>
> **注意**：macOS 27 于 2026-09-14 正式发布，距今仅 2 天，第三方实测数据很少。下文凡属推断或未经验证之处均显式标注。

---

## ① macOS 27 状态快照

**已确认（事实）：**

- **名称与版本**：macOS 27 "Golden Gate"，在 WWDC 2026（2026-06-08 主题演讲，Craig Federighi 主讲）上发布，沿用地名命名传统。[TechRadar](https://www.techradar.com/computing/mac-os/macos-27-golden-gate-announced-at-wwdc-2026-heres-everything-you-need-to-know)、[MacRumors roundup](https://www.macrumors.com/roundup/macos-27/)、[Macworld](https://www.macworld.com/article/3139330/macos-27-mac-features-siri-apple-intelligence-release-date-compatibility.html)
- **发布状态**：正式版已于 **2026-09-14** 推送；公开 Beta 为 2026-07-13；与 iOS 27 / iPadOS 27 / watchOS 27 / visionOS 27 同步发布。[mac.install.guide](https://mac.install.guide/macos/macos27)
- **硬件支持**：**首个完全放弃 Intel 的 macOS**，仅支持 Apple Silicon（MacBook Air 2020+、MacBook Pro 2020+、iMac 2021+、Mac mini 2020+、Mac Studio 2022+、Apple Silicon Mac Pro 2023+ 等）；4 款 Intel Mac 停留在 Tahoe 26（安全更新至 2028）。[mac.install.guide](https://mac.install.guide/macos/macos27)
- **SDK**：Apple 开发者网站已有《macOS 27 Golden Gate Release Notes》与 macOS 27 SDK。[Apple Developer](https://developer.apple.com/documentation/macos-release-notes/macos-27-release-notes)
- **与本调研最相关的系统变化**：新增 **Dock"后台运行"指示器**（灰色圆点 + "Running in Background" 悬停标签 + "Stop Running in Background" 右键菜单），配套系统设置项与官方 AppKit 开发者文档（详见 ③）。[MacObserver](https://www.macobserver.com/news/macos-27-golden-gate-makes-background-apps-much-easier-to-spot/)、[Apple 官方文档](https://developer.apple.com/documentation/appkit/managing-ongoing-background-processes-in-your-mac)
- **其他主要特性**：新 Siri（Apple Intelligence）、Visual Intelligence、可调 Liquid Glass 强度滑杆、更快的 Spotlight/AirDrop/Safari、原生菜单栏图标折叠/展开管理、彩色侧边栏图标、重绘红绿灯窗控、Rosetta 2 支持收窄。[mac.install.guide](https://mac.install.guide/macos/macos27)、[Six Colors 评测](https://sixcolors.com/post/2026/09/macos-27-golden-gate-review-bridging-the-tahoe-gap/)、[Folivora 社区](https://community.folivora.ai/t/macos-27-golden-gate-menu-bar-management-broken-solutions-ice-thaw-bartender-barbee-etc/47232)

**版本号推断（标注：推断，非官方确认）：**

- 用户当前 macOS 26 Tahoe 对应 darwin 25.6（本机 `uname` 实证）；依 Apple "产品版本号 = Darwin 主版本 + 1" 的既有规律，macOS 27 Golden Gate 应为 **darwin 26**。未找到 Apple 官方文档逐字确认，需实测验证。

**未知 / 信息不足：**

- 官方 Release Notes 全文为 JS 渲染页面，本次抓取未能提取正文；除"后台访问 Neural Engine 受限"一条外（搜索摘要提及，[Apple](https://developer.apple.com/documentation/macos-release-notes/macos-27-release-notes)），**AppKit 层面的完整变更清单、确切 build 号尚未核实**。
  -macOS 27 是否对 App Nap、launchd 行为有实质变化：未发现权威报道（详见 ⑤）。
- 正式版（而非 Beta）上"后台运行"指示器的最终行为细节仍在涌现，Gamma 建议以本机实测为准。

---

## ② macOS 26 Tahoe：Dock 与运行指示器的变化

- **Liquid Glass 重设计**：Dock 变为磨砂半透明背景，是多年来最大视觉改版；支持清晰/深色/着色图标风格，外观强度在系统设置 → 外观中调节。[The Verge](https://www.theverge.com/apple/685052/apple-macos-tahoe-26-beta-hands-on-liquid-glass-themes-spotlight)、[DockGroups guide](https://dockgroups.com/guides/macos-tahoe-dock/)
- **运行圆点（running dot）本身机制未变**：Tahoe 保留了"Show indicators for open applications"开关（系统设置 → 桌面与程序坞）。社区抱怨集中在两点：深色 Dock 背景让圆点更难看清；圆点对后台应用也显示。[YouTube 自定义指南](https://www.youtube.com/watch?v=h6TQzEIZRq4)、[Apple Discussions](https://discussions.apple.com/thread/256145805)、[Reddit r/mac](https://www.reddit.com/r/mac/comments/1o8wkzn/)
- **"最小化时将窗口收进应用图标"设置仍在**（Minimize windows into application icon）。[MacMost](https://macmost.com/reducing-dock-clutter-by-minimizing-into-application-icons.html)
- **Launchpad 移除**，替换为 Dock 中的"Apps"快捷方式（Spotlight 应用网格）。[OWC](https://eshop.macsales.com/blog/97761-missing-launchpad-after-upgrading-to-macos-tahoe-heres-how-to-get-it-back/)
- **Tahoe 自身没有新增"后台活动"Dock 指示器**——灰色的"Running in Background"指示是 macOS 27 才引入的（见 ③）。Tahoe 时代用户看到的相关讨论均为经典运行圆点的可见性问题。
- **开发者侧的间接变化（社区报告，标注：未获 Apple 官方证实）**：
  - Tahoe 26.2 起对 `LSUIElement` 的执行更严格（来自 [claude-code issue #62333](https://github.com/anthropics/claude-code/issues/62333) 中的评论）。
  - Tahoe 26.4 出现菜单栏图标显示权限门槛，需在系统设置 → Menu Bar 中授权（[stats issue #3120](https://github.com/exelban/stats/issues/3120)）。
  - 26.0 存在 Dock 偶发消失的 bug（`killall Dock` 可恢复）。[Apple Discussions](https://discussions.apple.com/thread/256138247)、[macreports](https://macreports.com/dock-disappears-randomly-on-macos-tahoe-26-0-how-to-fix/)
- 官方参考：[macOS Tahoe 26 Release Notes](https://developer.apple.com/documentation/macos-release-notes/macos-26-release-notes)。

---

## ③ "后台运行"指示机制与相关 API（核心章节）

### 3.1 macOS 27 新增：Dock 后台运行指示器（用户可见行为）

- 遭到"退出"后仍留有后台进程的应用，其 Dock 图标**保留并显示灰色圆点**（区别于活跃应用的黑点/指示点）；悬停显示"<App> is Running in Background"标签。[MacObserver](https://www.macobserver.com/news/macos-27-golden-gate-makes-background-apps-much-easier-to-spot/)、[9to5Mac](https://9to5mac.com/2026/06/09/macos-27-golden-gate-makes-it-clear-when-apps-are-sneakily-running-in-background/)
- 右键图标出现 **"Stop Running in Background"** 菜单项，选择后系统**立即终止进程**并从 Dock 移除图标；MacRumors 论坛用户讨论其语义接近 Force Stop / `kill`。[MacObserver](https://www.macobserver.com/news/macos-27-golden-gate-makes-background-apps-much-easier-to-spot/)、[MacRumors 论坛](https://forums.macrumors.com/threads/macos-27-all-the-little-things.2483520/page-6)
- 用户多次"Stop"后，系统会弹窗允许用户**永久禁止该应用的后台活动**。[Apple 官方文档](https://developer.apple.com/documentation/appkit/managing-ongoing-background-processes-in-your-mac)
- 新增系统设置：**General → Login Items & Extensions → "Background App Activity"**，列出有活动后台进程的应用并可逐个开关。[MacObserver](https://www.macobserver.com/news/macos-27-golden-gate-makes-background-apps-much-easier-to-spot/)
- 真实世界反馈：Google Gemini、OrbStack、Docker Desktop 等"退出后仍留进程"的应用被点名；Keyboard Maestro 自 Beta 1 起被永久显示为"Running in Background"（开发者认为与 Apple 有意暴露常驻进程有关，Beta 中无规避手段）。[9to5Mac](https://9to5mac.com/2026/06/09/macos-27-golden-gate-makes-it-clear-when-apps-are-sneakily-running-in-background/)、[mac.install.guide](https://mac.install.guide/macos/macos27)、[Keyboard Maestro 论坛](https://forum.keyboardmaestro.com/t/macos-27-app-stuck-in-dock-permanently-running-in-background/51842)
- Beta 期间无法隐藏：未固定到 Dock 的后台应用也会以图标 + 指示出现，用户无隐藏开关。[Reddit r/MacOSBeta](https://www.reddit.com/r/MacOSBeta/comments/1uryk6g/270db3_can_you_hide_running_in_the_background/)

### 3.2 官方开发者文档（一手来源，最重要）

Apple 新增 AppKit 文章 **《Managing ongoing background processes in your Mac》**（[链接](https://developer.apple.com/documentation/appkit/managing-ongoing-background-processes-in-your-mac)），要点（经 Apple 文档 JSON 端点提取核实）：

- **触发条件**：应用通过 helper app、XPC service、launch agent、或**直接 exec 的子进程**（`fork()` / `posix_spawn()` / `system()`）在用户关闭应用后继续运行 → 系统显示 Dock 指示器 + "Stop running in background" 菜单。
- **✅ 已实测确认（2026-09-16，macOS 27.0 build 26A428）**：Clash Party 的 detached + setuid-root mihomo 子进程**会被系统归因回应用 bundle**——`app.exit()` 后 Dock 图标保留、显示灰色"Running in Background"指示。exec 裸子进程归因的"需实测"项就此闭环。
- **规避 Dock 指示器的唯一文档化途径**：应用自身切换为 `UIElement` / `BackgroundOnly`（`NSApplication.setActivationPolicy(_:)` 或 `TransformProcessType(_:_:)`）→ **跳过 Dock 指示器**，但系统仍会发通知引导用户到 Settings → Login Items & Extensions。
- **自后台化应用（self-backgrounding）**：保有**可见菜单栏图标或窗口**的应用豁免于后台终止规则；失去 Dock 的应用会在短延迟后触发警告弹窗，用户可在系统设置中禁用其后台执行。
- **持久后台服务的推荐做法**：用 `SMAppService` 注册 launch agent / daemon（可用 `SMAppService.status` 查询状态）；exec 裸子进程被明确"不推荐"，建议改用 XPC service（自动被系统跟踪与终止）或 `SMAppService`。
- **非 UI 应用**：应在 Info.plist 声明 `NSSupportsAutomaticTermination`（优雅终止）或 `NSSupportsSuddenTermination`（立即终止）；运行时改动 `ProcessInfo.automaticTerminationOptOutCounter` 对此**无效**。
- **长任务进行中的可见性**：提供可见进度 UI 或带暂停/取消控件的 `MenuBarExtra`。
- **子后台应用**：应向其发送 Apple Events quit 事件（`kCoreEventClass` / `kAEQuitApplication`）。

### 3.3 激活策略与 LSUIElement（macOS 26/27 行为）

- 经典定义不变：`NSApplicationActivationPolicy.regular` 应用即使无窗口也可常驻并显示 Dock 图标 + 运行圆点；`.accessory` 应用"不出现在 Dock、无菜单栏，但可被编程激活"；`.prohibited` 完全不进 GUI。[Apple 文档：accessory](https://developer.apple.com/documentation/appkit/nsapplication/activationpolicy-swift.enum/accessory)
- **regular 策略 + 无可见窗口**的应用在 26/27 上依然保留 Dock 图标（经典行为，27 的灰色"后台"点正是为这类"还活着但没界面"的状态新增的视觉语义；macOS 27 会用灰点区分"完全退出但留有进程"与"前台活跃"——具体到"regular 且无窗口且自己还在跑"显示黑点还是灰点，**官方未逐字定义，需实测**）。
- **accessory 应用在 macOS 27 不会有任何 Dock 呈现**（定义如此），但按官方文档，切换为 UIElement 的应用**跳过**后台指示器——即"菜单栏-only"路线在 27 上不会触发布景指示与警告弹窗（代价正是没有 Dock 图标）。[Apple 官方文档](https://developer.apple.com/documentation/appkit/managing-ongoing-background-processes-in-your-mac)
- Tahoe 26.2+ 传闻"更严格的 LSUIElement 执行"、26.4 的菜单栏权限门槛（见 ②），提示纯菜单栏应用生态在 26.x 有摩擦（均为社区报告）。

### 3.4 其他"正在运行"表达手段

- **NSDockTile**（经典 API）：可在 Dock 图标上叠加 badge/自绘内容（[NSDockTile 文档](https://developer.apple.com/documentation/appkit/nsdocktile)），但**不能**制造系统级"运行圆点"。
- **NSProcessInfo activity**（`beginActivityWithOptions:`）：用于阻止 App Nap/休眠，**不是** Dock 指示器的驱动 API——Keyboard Maestro 论坛的讨论未找到任何被点名的 API，"灰点 = NSProcessInfo assertion 驱动"的说法仅为社区猜测，**未经证实**。[Keyboard Maestro 论坛](https://forum.keyboardmaestro.com/t/macos-27-app-stuck-in-dock-permanently-running-in-background/51842)
- **SMAppService**：注册 launch agent/daemon 的现代方式，注册项出现在 Settings → Login Items & Extensions（27 的 "Background App Activity" 列表同处）。[Apple 官方文档](https://developer.apple.com/documentation/appkit/managing-ongoing-background-processes-in-your-mac)
- 菜单栏（`MenuBarExtra` / Electron `Tray`）：27 中保有菜单栏图标即可豁免后台终止规则（见 3.2），但 27 的菜单栏生态在 Beta 中动荡（第三方管理器大面积失效、后续由原生折叠/展开按钮替代）。[Folivora 社区](https://community.folivora.ai/t/macos-27-golden-gate-menu-bar-management-broken-solutions-ice-thaw-bartender-barbee-etc/47232)

---

## ④ Electron 在 macOS 26/27 上的现状

- **当前稳定版**：Electron **44.4.1**（Chromium 152，Node 24），2026-09-15 发布；支持线为 42/43/44 三条。[Electron Releases](https://releases.electronjs.org/)。**Clash Party 目前用 `electron 43.2.0`**（`package.json`），在支持窗口内。
- **Tahoe 大坑（已修复）**：Electron 曾为窗口圆角调用 Apple 私有 API `_cornerMask`，在 Tahoe 上引发全系统卡顿（WindowServer GPU 负载异常）。修复版本：**36.9.2 / 37.6.0 / 38.2.0 / 39.0.0-alpha.7**。Clash Party 的 43.2.0 已包含修复。[GitHub #48311](https://github.com/electron/electron/issues/48311)、[Michael Tsai](https://mjtsai.com/blog/2025/09/30/electron-apps-causing-system-wide-lag-on-tahoe/)、[heise](https://www.heise.de/en/news/Under-macOS-26-Tahoe-huge-lag-with-Electron-apps-10692165.html)
- **`app.dock.hide()` / `app.dock.show()`**：
  - 已知限制：距上次调用**不足 1 秒**内的 `dock.hide()` 会静默失败（官方为规避更严重 bug 而加的速率限制）。[GitHub #37832](https://github.com/electron/electron/issues/37832)、[Electron Dock 文档](https://electronjs.org/docs/latest/api/dock)
  - 启动时调用 `dock.hide()` 会有图标闪烁（历史问题 [#3498](https://github.com/electron/electron/issues/3498)、[#24407](https://github.com/electron/electron/issues/24407)）；可通过 Info.plist `LSUIElement` 规避启动闪烁（[Stack Overflow](https://stackoverflow.com/questions/59668664/how-to-avoid-showing-a-dock-icon-while-my-electron-app-is-launching-on-macos)）。
  - Clash Party 已处理这套切换（`src/main/resolve/tray.ts` 的 `dock.show()/hide()`、`src/main/window.ts` 的 show 前恢复 dock），逻辑与 27 无冲突迹象——但**正式版 27 上的实测尚无第三方数据**。
- **Tray**：Sequoia 15.6 有 Tray 不显示的个案（[#48263](https://github.com/electron/electron/issues/48263)）；Tahoe 26.4 的菜单栏权限门槛影响所有 accessory 应用（[stats #3120](https://github.com/exelban/stats/issues/3120)）；macOS 27 Beta 中菜单栏管理混乱但属系统侧问题。[Folivora 社区](https://community.folivora.ai/t/macos-27-golden-gate-menu-bar-management-broken-solutions-ice-thaw-bartender-barbee-etc/47232)
- **`app.exit()` 与 detached 子进程**：未发现 Electron 层在 26/27 有相关回归报告；真正的风险来自系统侧（见 ⑤）。
- **macOS 27 专项**：正式版发布仅 2 天，**尚无有影响力的 Electron-on-27 兼容性问题报告**——这不代表没有，仅是数据真空。

---

## ⑤ detached 核心进程在 macOS 26/27 上的存活

- **App Nap 基本盘未变**：App Nap 针对非活跃 GUI 应用（降频、暂停 timer）；守护进程式无界面进程不受同等"打盹"影响。开发者可用 `NSProcessInfo.beginActivity` 主动豁免。[Apple 能效指南（存档）](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/AppNap.html)
- **没有发现 26/27 引入针对孤儿进程的系统性清除**的报道；社区在 27 Beta 中观察到的"后台程序变多"是**可见性**变化（新指示器）而非行为回归。[MacRumors 论坛](https://forums.macrumors.com/threads/many-programs-are-now-running-in-the-background.2483775/)
- **真正的系统侧新风险（macOS 27）**：
  1. 留有后台进程的应用会被 Dock 灰点 + Settings → Background App Activity **公示**，用户可一键 "Stop Running in Background" **杀掉 mihomo**（断网且无提示恢复路径），或在该设置面板直接关闭其后台权限。[MacObserver](https://www.macobserver.com/news/macos-27-golden-gate-makes-background-apps-much-easier-to-spot/)、[Apple 官方文档](https://developer.apple.com/documentation/appkit/managing-ongoing-background-processes-in-your-mac)
  2. Apple 文档明确**点名 exec 型裸子进程**（`fork()`/`posix_spawn()`/`system()`）为其监管对象，推荐改为 XPC 或 `SMAppService`——Clash Party 现在的 detached mihomo 正属此类。孤儿化 + setuid-root 之后是否仍被归因（attribution）回应用 bundle，**官方未写明，需实测**；但即使归因失败，Settings 的 Background Items 列表机制（SMAppService 时代已存在）也可能单独呈现。
  3. Release Notes 摘要提及"后台访问 Neural Engine 受限"及企业侧新增"app/binaries 启动管理"（MDM），显示后台管控整体趋严（对 mihomo 无直接影响，但方向如此）。[Apple](https://developer.apple.com/documentation/macos-release-notes/macos-27-release-notes)、[What's New for Enterprise](https://support.apple.com/en-us/148830)
- **结论**：mihomo 作为 detached 进程**技术上仍能活**，但 macOS 27 首次让它"可见、可停、可禁"——轻量模式的用户体验从"无感"变为"暴露在系统 UI 中，且可被用户一键误杀"。**归因已在 27.0 正式版实测确认**（见 3.2）。

---

## ⑥ 对 Clash Party 轻量模式的启示

用户诉求：轻量模式下在 Dock 保留图标并呈现"正在后台运行"。三个候选方案（代码位置：`src/main/core/manager.ts` 的 `quitWithoutCore()`、`src/main/resolve/tray.ts`、`src/main/window.ts`）：

### 方案 A：保活 + 隐藏窗口（推荐评估的方向）

轻量模式不再 `app.exit()`，而是销毁/隐藏渲染窗口、核心照常由主进程托管（代码中已存在"lightweight tray mode destroys the renderer window"的保活路径，见 `src/main/lifecycle.ts` 的 `window-all-closed` 注释），并强制 `app.dock.show()`（regular 策略）。

- **效果**：Dock 有图标。有窗口（哪怕隐藏）或有菜单栏图标时按官方口径**豁免**后台终止规则；27 上"无窗口常驻"很可能显示灰点/黑点（哪一种需实测）——恰好就是用户想要的"运行中"语义。
- **优点**：完全符合 Apple 的受监管路径，不存在孤儿进程归因问题；恢复主窗口瞬时完成；系统设置里不会被禁后台。
- **缺点**：Electron 常驻内存（数百 MB），与"轻量"的初衷相悖；`useDockIcon=false` 用户（本人）需要模式化的 dock 策略覆盖（`dock.hide/show` 切换受 1 秒速率限制，[#37832](https://github.com/electron/electron/issues/37832)）；台前调度下 `dock.hide()` 时机敏感（`tray.ts` 已有注释处理）。

### 方案 B：菜单栏-only（accessory，保持 app 活着但不进 Dock）

保持 app 活着 + Tray，`app.dock.hide()`（当前 `useDockIcon=false` 行为的延伸）。

- **效果**：Dock **无图标**（accessory 的定义行为，[Apple 文档](https://developer.apple.com/documentation/appkit/nsapplication/activationpolicy-swift.enum/accessory)）→ **不满足用户"Dock 显示后台运行"的诉求**；但按 Apple 文档，UIElement 切换**跳过** 27 的后台指示器与警告弹窗，菜单栏图标本身豁免后台终止规则（见 3.2）。
- **优点**：内存占用低于 A（仍需 Electron 常驻）；系统层面最"安静"。
- **缺点**：Dock 无任何呈现；Tahoe 26.2/26.4 对 LSUIElement/菜单栏有收紧迹象（社区报告）；用户必须依赖 Tray 辨识状态。

### 方案 C：维持完全退出（现状），但把核心"正名"

维持 `quitWithoutCore()` 的 detached 核心，可选地把核心注册为 `SMAppService` daemon/agent（root 网络服务本就适合 LaunchDaemon 形态），接受它出现在 Settings 列表。

- **效果**：主进程零占用；27 上灰点/Settings 公示取决于系统对孤儿进程的归因，**行为不可控且可能触发"Stop Running in Background"被用户一键杀核心**（断网无提示）。
- **优点**：资源占用最低；实现最简单（现状）。
- **缺点**：Dock 完全无图标（现状即用户的痛点）；27 下被公示/误杀风险；Apple 文档明确不推荐 exec 裸子进程模式（[Apple 官方文档](https://developer.apple.com/documentation/appkit/managing-ongoing-background-processes-in-your-mac)）；setuid-root 核心改造成 SMAppService daemon 工程量大（plist、安装/卸载、升级迁移）。

### 综合建议

- 短期（macOS 26）：维持现状可用；27 上线前必须实测 `quitWithoutCore()` 后 mihomo 是否在 Dock/Settings 被归因呈现。
- 中期：把"轻量模式"拆成两档——**"轻量（保活）"** = 方案 A（Dock 图标 + 灰点，符合用户诉求，系统友好）；**"极轻/退出留核"** = 方案 C（接受系统公示风险，并在 UI 上告知用户 macOS 27 的 "Stop Running in Background" 会直接杀核心导致断网）。
- 无论哪档，**不要**在 27 上让应用以 regular 策略静默退出后还留 detached 进程——这是 Apple 文档点名监管、且用户可一键终止的形态。

---

## 来源

- Apple 官方：
  - Managing ongoing background processes in your Mac — https://developer.apple.com/documentation/appkit/managing-ongoing-background-processes-in-your-mac
  - macOS 27 Release Notes — https://developer.apple.com/documentation/macos-release-notes/macos-27-release-notes
  - macOS Tahoe 26 Release Notes — https://developer.apple.com/documentation/macos-release-notes/macos-26-release-notes
  - NSApplication.ActivationPolicy.accessory — https://developer.apple.com/documentation/appkit/nsapplication/activationpolicy-swift.enum/accessory
  - NSDockTile — https://developer.apple.com/documentation/appkit/nsdocktile
  - App Nap（能效指南存档）— https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/AppNap.html
  - What's New for Enterprise in macOS Golden Gate 27 — https://support.apple.com/en-us/148830
- 媒体 / 评测：
  - 9to5Mac: macOS 27 makes it clear when apps are running in background — https://9to5mac.com/2026/06/09/macos-27-golden-gate-makes-it-clear-when-apps-are-sneakily-running-in-background/
  - MacObserver: macOS 27 Golden Gate Makes Background Apps Much Easier to Spot — https://www.macobserver.com/news/macos-27-golden-gate-makes-background-apps-much-easier-to-spot/
  - Six Colors: macOS 27 Golden Gate review — https://sixcolors.com/post/2026/09/macos-27-golden-gate-review-bridging-the-tahoe-gap/
  - TechRadar: macOS 27 Golden Gate announced — https://www.techradar.com/computing/mac-os/macos-27-golden-gate-announced-at-wwdc-2026-heres-everything-you-need-to-know
  - MacRumors: macOS 27 roundup — https://www.macrumors.com/roundup/macos-27/
  - Macworld: macOS 27 features/compatibility — https://www.macworld.com/article/3139330/macos-27-mac-features-siri-apple-intelligence-release-date-compatibility.html
  - mac.install.guide: macOS 27 — https://mac.install.guide/macos/macos27
  - The Verge: macOS Tahoe 26 hands-on — https://www.theverge.com/apple/685052/apple-macos-tahoe-26-beta-hands-on-liquid-glass-themes-spotlight
  - heise: Electron lag under macOS 26 — https://www.heise.de/en/news/Under-macOS-26-Tahoe-huge-lag-with-Electron-apps-10692165.html
  - Michael Tsai: Electron Apps Causing System-Wide Lag on Tahoe — https://mjtsai.com/blog/2025/09/30/electron-apps-causing-system-wide-lag-on-tahoe/
- 社区 / 开发者报告：
  - Keyboard Maestro 论坛：App stuck "Running in Background" — https://forum.keyboardmaestro.com/t/macos-27-app-stuck-in-dock-permanently-running-in-background/51842
  - MacRumors 论坛：Many Programs now running in the Background — https://forums.macrumors.com/threads/many-programs-are-now-running-in-the-background.2483775/
  - MacRumors 论坛：macOS 27 all the little things — https://forums.macrumors.com/threads/macos-27-all-the-little-things.2483520/page-6
  - Reddit r/MacOSBeta：隐藏 "Running in the background" — https://www.reddit.com/r/MacOSBeta/comments/1uryk6g/270db3_can_you_hide_running_in_the_background/
  - Reddit r/mac：Tahoe 运行指示器 — https://www.reddit.com/r/mac/comments/1o8wkzn/
  - Apple Discussions：Tahoe Dock 指示器可见性 — https://discussions.apple.com/thread/256145805 ；Dock 消失 — https://discussions.apple.com/thread/256138247
  - claude-code #62333（Tahoe 26.2 LSUIElement 收紧评论）— https://github.com/anthropics/claude-code/issues/62333
  - stats #3120（Tahoe 26.4 菜单栏权限）— https://github.com/exelban/stats/issues/3120
  - Folivora 社区：macOS 27 菜单栏管理失效 — https://community.folivora.ai/t/macos-27-golden-gate-menu-bar-management-broken-solutions-ice-thaw-bartender-barbee-etc/47232
- Electron：
  - Electron Releases — https://releases.electronjs.org/
  - #48311（Tahoe `_cornerMask` 卡顿与修复版本）— https://github.com/electron/electron/issues/48311
  - #37832（dock.hide 1 秒速率限制）— https://github.com/electron/electron/issues/37832
  - #3498（启动 dock 闪烁）— https://github.com/electron/electron/issues/3498
  - #48263（Sequoia Tray 问题）— https://github.com/electron/electron/issues/48263
  - Electron Dock 文档 — https://electronjs.org/docs/latest/api/dock
  - OWC（Launchpad → Apps）— https://eshop.macsales.com/blog/97761-missing-launchpad-after-upgrading-to-macos-tahoe-heres-how-to-get-it-back/
  - MacMost（最小化进应用图标）— https://macmost.com/reducing-dock-clutter-by-minimizing-into-application-icons.html
