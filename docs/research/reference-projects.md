# 参考项目库

这里记录 dsh-tavern 开发过程中值得查阅的上游与社区项目。

需要研究酒馆兼容行为、预设、世界书、正则、HTML 展示或 DSH 接入方式时，先按问题查找对应项目的实际源码，再形成设计结论。不要仅凭项目名称、README 或旧研究报告推断当前实现。

## 语义基准

### SillyTavern

- 仓库：<https://github.com/SillyTavern/SillyTavern>
- 用途：核对人物卡、预设、世界书、正则、宏、消息存储与展示等酒馆原生语义。
- 定位：酒馆兼容行为的主要语义基准。遇到社区实现与酒馆本体不一致时，应先说明差异，而不是默认社区实现等同于酒馆。
- 历史研究基线：`release` 分支，提交 `8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8`。本地参考副本已清理，需要时从上游重新取得。
- 已有研究：[酒馆正则如何把 `【首页】` 变成可交互卡片](sillytavern-regex-rendering-memo.md)

## 社区参考实现

### 酒馆助手 / JS-Slash-Runner

- 仓库：<https://github.com/N0VI028/JS-Slash-Runner>
- 用途：核对酒馆助手如何识别消息中的前端代码块，并用 `iframe srcdoc` 或 Blob URL 渲染交互界面。
- 历史研究基线：`main` 分支，提交 `4dd4b873f191accb5dd933089ddf36b846458585`。本地参考副本已清理，需要时从上游重新取得。
- 已有研究：[酒馆正则如何把 `【首页】` 变成可交互卡片](sillytavern-regex-rendering-memo.md)

### ST Prompt Template

- 仓库：<https://github.com/zonde306/ST-Prompt-Template>
- 历史研究基线：`master` 分支，提交 `9bf9bcdfa8d0d38ab1f4f7342067bc16f347d85d`。本地参考副本已清理。
- 产品内的 vendor 源码与构建产物仍保留在 `tavern-plugin/lib/vendor/st-prompt-template/`。

### dsh-agent-rp

- 仓库：<https://github.com/hewzhew/dsh-agent-rp>
- 用途：参考酒馆资产在 DSH 环境中的运行、隔离、正则、世界书和 HTML 能力处理方式。
- 已有研究：[dsh-agent-rp 兼容运行时研究](dsh-agent-rp-compat-runtime.md)

### Liyuan

- 仓库：<https://github.com/weidu12123/Liyuan>
- 用途：参考酒馆预设、上下文组织、兼容边界和项目架构。
- 已有研究：[梨园架构研究与借鉴范围](liyuan-architecture-reference.md)

### LingyeSoul/dsh-tavern

- 仓库：<https://github.com/LingyeSoul/dsh-tavern>
- 用途：参考社区对 dsh-tavern 的改造、问题处理和交互方案，并与本项目当前分支进行差异比较。
- 注意：同名仓库不代表实现、版本或设计目标一致；引用前应记录具体分支、提交和查阅日期。

### dsh-visualize

- 仓库：<https://github.com/Nagi-ovo/dsh-visualize>
- 用途：参考 DSH 正式 UI 插槽、对话内工具卡片，以及 `iframe srcDoc`、sandbox、CSP、自动高度和主题桥接机制。
- 已有研究：[dsh-visualize：HTML 如何进入 DSH 对话流](dsh-visualize-html-embedding.md)
- 注意：它使用的是工具展示插槽；普通助手正文需要通过 `conversation.chat.node / assistant-step` 另行接管。

## 查阅原则

1. 先明确要回答的具体问题，再选择参考项目。
2. 记录被参考的分支、提交或版本，避免把旧实现当成当前事实。
3. 区分“酒馆原生语义”“社区实现经验”和“本项目正式设计”。
4. 参考实现只提供证据与备选方案；是否采用仍由 dsh-tavern 的产品目标和 DSH 原生能力决定。
5. 研究结论应另写专题报告，并从本页或文档索引链接过去。
