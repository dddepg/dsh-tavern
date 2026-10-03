# 更新故障日志

安装支持更新诊断的版本后，重现检查或更新失败，再点对话顶部的“日志”。导出的 ZIP 内 `update/diagnostics.json` 是本机更新历史，包含其他会话期间的更新操作。整个 ZIP 仍含私人对话，分享前请检查。

没有可用对话时，可直接提供实际 Profile 数据目录中的 `update-diagnostics.jsonl` 和 `update-diagnostics.jsonl.1`。一般位于 `profile-data/tavern/data/` 下；不是程序源码目录。

记录包含操作 ID、时间、宿主、系统与 Node 版本、当前构建、CDN 比较结果、转向 GitHub 的原因、请求地址（去除凭据及查询参数）、HTTP 状态、阶段耗时、底层错误码、安装进程状态及末尾输出。安装子进程通过 PID、时间和目标提交关联。

日志约每 1 MiB 轮转，保留当前及上一份；单条文本最多 6000 字符。写日志失败不阻断更新。不会补录旧版本发生过的故障；更新状态文件仍只保存最近状态。该记录不上传服务器。

## Windows 更新与中断恢复

界面更新通过 Windows WMI 启动独立更新进程，保留安装目录、代理及宿主环境。这样停止旧服务时，更新器不会留在旧服务的进程树或第三方启动器的 Job 中。WMI 启动失败会直接显示错误；请先确认没有更新正在进行，再从外部终端运行 `dsh-tavern update`。旧版本需要先通过外部终端安装包含此修复的版本，才能使用新的界面启动方式。

Windows 的普通子进程会继承 Job，`detached` 本身不能解决这一问题。WMI 创建及 Job 行为依据微软的 [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) 和 [Win32_Process.Create](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/create-method-in-class-win32-process) 文档；实现显式设置 `CREATE_BREAKAWAY_FROM_JOB`，同时脱离 WMI 提供程序自身的 Job。

安装进程仍存活时，不会仅因超过 15 分钟就标记中断，也不会允许再次启动安装器。进程退出且未记录成功时，界面保留修复入口；即使源码版本已经更新，仍可重新安装，补完依赖和配置。没有登记进程号的旧记录超过 15 分钟后按中断恢复。

jsDelivr 文件下载阶段有 5 分钟总预算，单次请求仍为 30 秒、最多尝试两次。总预算耗尽后停止剩余请求、记录错误并转入完整 ZIP 备用方案；这不是整个安装过程的时间上限。代理连接和 TLS 错误仍需结合本机网络诊断，更新器不会修改用户的代理配置。
