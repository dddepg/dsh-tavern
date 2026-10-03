# 开发与实验脚本

`experiments/` 集中存放独立实验脚本及固定实验结果。方法与结论见 [`docs/experiments/`](../docs/experiments/) 和 [`docs/research/`](../docs/research/)。固定结果用于保留历史证据，不代表当前版本已通过同样的验证。

`settlement-*.mjs` 是显式调用模型的实验，需要 `DEEPSEEK_API_KEY`，会产生调用费用，不加入自动测试。按对应报告的命令运行，新结果写入 `output/` 或临时目录。

`repro-dsh-015-session.mjs` 与 Session patch 实验针对指定的历史 DSH 版本。先阅读脚本和研究报告，仅在可丢弃的运行环境上复现。

生产启动、安装、升级和构建入口仍在 [`bin/`](../bin/)；浏览器验证与性能基准分别在 [`tests/browser/`](../tests/browser/) 和 [`tests/performance/`](../tests/performance/)。
