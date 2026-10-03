<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/flizzywine/dsh-tavern/main/docs/assets/brand/dsh-tavern-lockup-on-dark.svg">
    <img src="docs/assets/brand/dsh-tavern-lockup.svg" width="360" alt="DSH 酒馆">
  </picture>
</p>

# dsh-tavern

**类酒馆文字游戏 Agent。兼容 SillyTavern 生态，人物卡直接导入就能玩。**

更快 · 更稳 · 更鲜活 · 所有模型都能用（不限于 DeepSeek）· 手机也能玩

[![观看 3 分钟实机演示：兼容酒馆生态，更快、更稳、更鲜活](docs/images/readme/promo-video.jpg)](https://www.bilibili.com/video/BV1MHaU6NE7S/)

[下载安装](#快速开始) · [使用文档](https://flizzywine.github.io/dsh-tavern/) · [宣传视频](https://www.bilibili.com/video/BV1MHaU6NE7S/) · [Discord 交流](https://discord.com/channels/1134557553011998840/1538577327028445194)

- **兼容 SillyTavern 生态**：人物卡、世界书、预设、正则美化、MVU、酒馆助手脚本，导入就能用，默认无需外部预设。
- **更快**：一轮约 10 秒，缓存命中率 95% 以上。
- **更稳**：状态栏不再掉格式。变量由后台按规则结算，每轮附更新结果，失败可单独重试；更新与重装都保留数据。
- **更鲜活**：同样的模型、同样的预设，比原版酒馆更有活人感。因为前台模型只管写正文，变量结算等任务性工作交给后台模型。
- **手机也能玩**：Android 手机直接安装；电脑上运行的酒馆，手机扫码就能远程游玩。

## 看看实际效果

**MVU 状态栏**：人物状态随剧情变化，正文下方可查看本轮更新了什么。

![MVU 人物卡的变量更新结果与右侧酒馆状态栏](docs/images/readme/mvu-status-panel.png)

**小手机**：边读剧情，边看角色发来的消息。

![正文与右侧小手机聊天界面](docs/images/readme/phone-panel.png)

**场景插画**：为当前剧情配一张图。

![公开灯塔案例的场景插画与完整产品界面](docs/images/readme/scene-image-product.png)

## 快速开始

### Windows

**方式一：一键安装包（推荐）**

**[下载 Windows 安装包](https://github.com/flizzywine/dsh-tavern/releases/download/v2.4/DSH-Tavern-Desktop-2.0.13-x64-Setup5.exe)**（x64），双击运行，保持联网，按提示完成。以后从桌面「DSH Tavern」快捷方式打开，无需另装 Node.js 或 DSH Desktop。[图文教程 →](https://flizzywine.github.io/dsh-tavern/#a02--section-2)

**方式二：借助 DSH Desktop**

先安装 **[DSH Desktop 2.0.13](https://github.com/anywhere-labs/dsh-desktop/releases/tag/v2.0.13)**，在 **设置 → 通用设置 → 打开 DSH 终端** 中运行下面的命令，完成后重启 Desktop，选择 **tavern** Profile。[图文教程 →](https://flizzywine.github.io/dsh-tavern/#a02--section-3)

```powershell
$env:DSH_TAVERN_HOST='desktop'; $tavernInstaller=[Text.Encoding]::UTF8.GetString((New-Object Net.WebClient).DownloadData('https://cdn.jsdelivr.net/gh/flizzywine/dsh-tavern@main/install.ps1')); Invoke-Expression $tavernInstaller
```

**方式三：命令行**

需要 **Node.js 22.19+**，在 PowerShell 中运行，安装后自动打开网页，以后用 `dsh-tavern open` 打开。[详细说明 →](https://flizzywine.github.io/dsh-tavern/#a02--section-4)

```powershell
$env:DSH_TAVERN_HOST='cli'; $tavernInstaller=[Text.Encoding]::UTF8.GetString((New-Object Net.WebClient).DownloadData('https://cdn.jsdelivr.net/gh/flizzywine/dsh-tavern@main/install.ps1')); Invoke-Expression $tavernInstaller
```

### macOS

先安装 **[DSH Desktop 2.0.13](https://github.com/anywhere-labs/dsh-desktop/releases/tag/v2.0.13)**，在 **设置 → 通用设置 → 打开 DSH 终端** 中运行：

```bash
curl -fsSL https://cdn.jsdelivr.net/gh/flizzywine/dsh-tavern@main/install.sh | DSH_TAVERN_HOST=desktop sh
```

完成后重启 Desktop，选择 **tavern** Profile。[图文教程 →](https://flizzywine.github.io/dsh-tavern/#a02--section-3)

### Linux

需要 **Node.js 22.19+**，在终端运行：

```bash
curl -fsSL https://cdn.jsdelivr.net/gh/flizzywine/dsh-tavern@main/install.sh | DSH_TAVERN_HOST=cli sh
```

安装后自动打开网页；以后用 `dsh-tavern open` 打开。[详细说明 →](https://flizzywine.github.io/dsh-tavern/#a02--section-4)

### Android

**方式一：一键安装（推荐）**

**[下载 Android APK](https://github.com/flizzywine/dsh-tavern/releases/download/v2.1/dsh-tavern-android-release.apk)**（Android 11+、ARM64），安装后打开，点击启动，首次保持联网等待自动安装完成。[图文教程 →](https://flizzywine.github.io/dsh-tavern/#a02--section-5)

**方式二：借助 DSHA**

已在用 **[DSHA](https://github.com/DSH-APP/DSHA/releases)** 的，可以在 DSHA 中安装并启动酒馆。[图文教程 →](https://flizzywine.github.io/dsh-tavern/#a02--section-6)

### 手机远程访问

酒馆跑在电脑或服务器上，用手机浏览器也能玩。[详细说明 →](https://flizzywine.github.io/dsh-tavern/#a02--section-10)

- **电脑运行、手机扫码**：Desktop 版已自带 [dsh-pocket](https://github.com/shaobeichen/dsh-pocket)，在 **设置 → 手机访问** 选择局域网或公网，扫码即可。
- **服务器部署、账号登录**：安装 [dsh-webui-auth](https://github.com/Yuuz12/dsh-webui-auth)，为远程网页加上登录认证。

### 开始游玩

在 **设置 → 模型** 填入模型服务和 API 密钥（任意模型都可以，本地模型也行），导入人物卡就能开局。[图文教程 →](https://flizzywine.github.io/dsh-tavern/#a02--section-7)

**更新与重装：**在酒馆里点「更新到最新版」即可更新。需要重装时，重新运行原来的安装包或命令，只替换程序，人物卡、聊天和设置都会保留。[详细说明 →](https://flizzywine.github.io/dsh-tavern/#a02--section-9)

安装失败时看[常见故障](https://flizzywine.github.io/dsh-tavern/#a02--section-11)；macOS 命令行安装、已有 DSH 的[插件安装](https://flizzywine.github.io/dsh-tavern/#plugin-installation)等见[完整安装指南](https://flizzywine.github.io/dsh-tavern/#a02)（宿主适配 DSH **0.1.5-rc.2**）。

## 交流与反馈

欢迎到 [Discord 讨论频道](https://discord.com/channels/1134557553011998840/1538577327028445194)交流使用经验、分享人物卡或反馈问题。需要具备类脑社区成员资格才能进入。

反馈故障时，可从对话顶部的“日志”下载执行记录；分享前请检查其中的对话和附件隐私。

## 贡献者与致谢

感谢 [@huajiao1998（meng）](https://github.com/huajiao1998) 持续提交详细的问题报告、复现步骤、性能分析和修复建议，并协助验证改进，帮助完善长会话、后台任务和界面稳定性。

## 用户怎么说

[![用户反馈：同样预设下比酒馆更有活人感，速度也更快](docs/images/readme/testimonials/more-alive-and-faster.jpg)](docs/images/readme/testimonials/more-alive-and-faster.jpg)

[![用户反馈：游玩五六百层后，仍能记起开局物品的来历](docs/images/readme/testimonials/long-chat-memory.jpg)](docs/images/readme/testimonials/long-chat-memory.jpg)

[![用户反馈：长局 184 轮仍保持 99% 缓存命中与 272 tok/s](docs/images/readme/testimonials/long-session-cache-hit.png)](docs/images/readme/testimonials/long-session-cache-hit.png)

[![用户反馈：会主动推进剧情，引入新角色和新事件](docs/images/readme/testimonials/proactive-story.webp)](docs/images/readme/testimonials/proactive-story.webp)

<details>
<summary>更多用户反馈</summary>

[![用户反馈：使用本地 27B 模型，体验非常良好](docs/images/readme/testimonials/local-27b.webp)](docs/images/readme/testimonials/local-27b.webp)

[![用户分享缓存命中率与几十轮游玩的实际花费](docs/images/readme/testimonials/cache-and-cost.webp)](docs/images/readme/testimonials/cache-and-cost.webp)

[![关于默认预设、回复速度与 Guide 剧情引导的反馈](docs/images/readme/testimonials/default-preset-and-guide.jpg)](docs/images/readme/testimonials/default-preset-and-guide.jpg)

[![关于使用体验的反馈](docs/images/readme/testimonials/ease-of-use.webp)](docs/images/readme/testimonials/ease-of-use.webp)

[![关于记忆系统的反馈](docs/images/readme/testimonials/memory-feedback.webp)](docs/images/readme/testimonials/memory-feedback.webp)

[![用户聊天反馈](docs/images/readme/testimonials/chat-feedback.webp)](docs/images/readme/testimonials/chat-feedback.webp)

[![关于文笔的反馈](docs/images/readme/testimonials/writing-feedback.webp)](docs/images/readme/testimonials/writing-feedback.webp)

[![社区用户对插件的反馈](docs/images/readme/testimonials/plugin-feedback.webp)](docs/images/readme/testimonials/plugin-feedback.webp)

[![用户对整体使用体验的评价与稳定版适配的询问](docs/images/readme/testimonials/overall-experience.webp)](docs/images/readme/testimonials/overall-experience.webp)

[![用户反馈：缓存命中率高](docs/images/readme/testimonials/cache-hit-feedback.webp)](docs/images/readme/testimonials/cache-hit-feedback.webp)

[![用户反馈：MVU 体验不错，喜欢按要求重新生成文本的功能](docs/images/readme/testimonials/mvu-and-rewrite.webp)](docs/images/readme/testimonials/mvu-and-rewrite.webp)

[![用户反馈：回复速度快，十几秒即可收到回复](docs/images/readme/testimonials/reply-speed.webp)](docs/images/readme/testimonials/reply-speed.webp)

[![用户反馈：特别好用，游玩体验更好](docs/images/readme/testimonials/play-experience.png)](docs/images/readme/testimonials/play-experience.png)

[![用户反馈：Agent 写作的输出质量更高](docs/images/readme/testimonials/agent-writing-quality.png)](docs/images/readme/testimonials/agent-writing-quality.png)

[![用户反馈：修改角色卡像给游戏装 MOD，改卡本身也很有趣](docs/images/readme/testimonials/character-card-editing.jpg)](docs/images/readme/testimonials/character-card-editing.jpg)

[![用户反馈：世界书和角色卡调整方便，与 DSH 语音阅读插件兼容良好](docs/images/readme/testimonials/setup-and-plugin-compatibility.jpg)](docs/images/readme/testimonials/setup-and-plugin-compatibility.jpg)

[![用户反馈：AI 修改内容方便，变量更新稳定，轻前端游玩体验不错](docs/images/readme/testimonials/ai-editing-and-variable-stability.jpg)](docs/images/readme/testimonials/ai-editing-and-variable-stability.jpg)

</details>
