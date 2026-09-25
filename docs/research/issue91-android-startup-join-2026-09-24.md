# Android 安装重叠启动修复

## 根因与边界

安装时已有被 PID 身份校验确认的 Tavern 进程正在启动，第二个 CLI start 把尚未就绪直接当作错误。MuMu 上安装器退出后，原进程随后成功监听 3088。此问题不同于此前 requestPerformance 初始化顺序错误。

start 现在等待已有进程就绪，复用原 PID。等待使用原有启动超时（Android 默认 120 秒）和 HTTP 就绪探测；等待者超时不杀原进程、不删除 PID 记录。身份消失或改变仍报错。

## 可重复回归

`node --test tests/launcher-lifecycle.test.mjs tests/service-startup.test.mjs`

真实 CLI 配合延迟监听的 HTTP 子进程：第一个 start 写入 PID 后调用第二个 start。修复前退出码 1，提示已有进程正在启动；修复后等待并返回同一 PID。另验证短超时等待者不影响原启动进程及记录。共 5 项通过。

## MuMu Android 12 实测

DSHA，固定 DSH 0.1.5-rc.2。将本地修改的 service-lifecycle.mjs 复制到上轮保留的新源码目录 `/root/.dsh/apps/dsh-tavern-issue91`，没有推送远程。

- 重跑该目录的 `android/install.sh`：输出“安装完成”，`ISSUE91_FIXED_EXIT=0`。
- stop 后后台运行第一个 start，等待 PID 文件出现，再前台运行第二个 start。两个命令退出成功，`OVERLAP_EXIT=0`。
- 第二个命令输出“正在等待已有 DSH Tavern 进程就绪：PID 6387”，随后“DSH Tavern 已经在运行：PID 6387”；第一个命令输出“DSH Tavern 已启动：PID 6387”。

本次不是重新下载官方 setup.sh 的全链路验收（远程尚无此补丁），也不是报告者真机验证。旧目录缺少安装来源标记的保护未放宽，保留旧目录及备份。
