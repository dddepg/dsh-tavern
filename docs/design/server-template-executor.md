# 服务端完整提示词模板执行

提示词模板使用 Node 子进程运行固定版本的 ST-Prompt-Template，jsdom 提供 DOM，保留原有宿主接口。生产执行不需要 Chromium、网页 iframe、浏览器认证 Cookie 或就绪心跳。网页继续负责显示和编辑。

## 为什么迁移

之前服务端向网页分派模板任务。新聊天可能没有对应的模板 iframe，后台结算和候选生成便先后等待就绪超时；这段等待发生在请求模型之前。新实现由服务端按需创建执行器，生命周期与选中页面无关。

## 执行与状态

- opening 初始化、输入、世界书逐条处理、正文请求投影、结算、候选及 `/ejs` 共用 `createServerTemplateRuntime`。
- 每会话一个独立 Node 进程和串行队列，最多四个进程；满额时排队，优先回收空闲进程。空闲十分钟回收，单次初始化或执行上限两分钟。
- worker 的 V8 老生代预算默认 1024 MB（原为 256 MB），按需使用，并非预先分配。可在启动服务前设置 `DSH_TAVERN_TEMPLATE_HEAP_MB`，接受 128–4096 的整数；程序调用可通过 `maxOldSpaceMb` 覆盖。该数字不是整个进程的 RSS 硬上限，多会话部署需结合设备内存配置。
- 进程崩溃时保留有界、脱敏的 stderr 尾部、退出码/信号和内存配置，写入服务日志及 `template-work` 的失败记录；显示同步这类临时任务失败也留记录。只有 V8 fatal stderr 明确报告内存耗尽时才标记 OOM，不能仅凭 SIGABRT 判定。
- 每条模板仍通过原有 `createNativeTemplateConnection` 刷新权威状态、准备上下文及等待保存。批量操作不跳过逐条刷新，不缓存求值结果。
- 聊天写入和会话展示使用已有聊天的模式、存储版本和结算状态触发合并后的显示处理，不再为调度重复读取整份会话投影。结算 pending/running 时暂停调度，后续状态变化唤醒；其他无进展的 deferred 重试按 250 毫秒起步指数退避，间隔最多 5 秒。完成批次或新版本到来恢复正常调度，未完成历史不会因重试次数被丢弃。历史显示仍由消息版本和原有上游标记决定是否重算。
- 参数和结果经 IPC 传递。父进程固定 sessionId，并只接受模板所需的 RPC。已提交的写入在失败后的队列继续前排空；旧进程的后续 RPC 不再接收。
- 取消会终止进程并取消本会话排队任务。崩溃和超时不自动重跑已经开始的模板；下一次显式调用可创建新执行器。持久记录保存任务状态，不保存或重放输入正文。
- system 与 messages 的投影仍复用原有代码，tools 和模型请求装配没有修改。

## 兼容边界

上游源码未修改。服务端构建保留 handler、command、settings 和 exports 模块，省去交互式 Monaco 模块；设置和世界书正文使用网页表单编辑，执行命令发往服务端。编译 Worker 接口在独立进程内适配，保留上游 EJS 编译器及可选兼容沙箱。

`/send … | /trigger` 和 `/trigger` 通过服务端排队提交。其他已注册命令交给宿主命令服务。`/setinput` 属于网页输入框操作，服务端明确报告不支持，不等待网页响应。

人物卡展示脚本、MVU 和 Helper 的浏览器运行时不属于提示词模板执行器，仍保留。纯 API 对需要这些脚本的人物卡继续报告 requiresBrowser。

jsdom 不是安全沙箱。子进程清除继承的环境变量和启动参数，使用 Node permission 限制文件读取到代码/依赖，禁止文件写入、子进程和 native addon；主服务不在自己的 JavaScript realm 中执行模板。这不是 OS 级敌对代码隔离保证。

## 构建与分发

`jsdom@26.1.0` 是正式依赖，根目录和插件安装均包含；无需额外下载浏览器。服务端产物在 `tavern-plugin/lib/vendor/st-prompt-template/server-artifact`，由安装器和运行包清单自动纳入。

构建命令：

```sh
node tavern-plugin/lib/vendor/st-prompt-template/host-build/build-server.mjs <固定上游 package-lock 的 npm ci 目录> <产物目录>
```

构建先审计上游锁定文件。更新产物后必须执行服务端模板测试和客户端构建检查。历史浏览器传输仅保留在 tests/fixtures 中供比较，不存在生产回退路径。

本地验证环境为 macOS / Node 22.22。Windows、Linux、Android 的实际运行未在本机验证；不以打包文件检查代替跨平台运行验证。

## 验证

- 服务端真实上游引擎：DOM、异步编译、兼容沙箱、YAML、Lodash、世界书、变量作用域和初始变量。
- 无网页执行，会话隔离、同会话排序、进程池排队、死循环终止、取消及显式恢复。
- 真实 Chat Journal / Profile 数据读写、增量快照、跨存储实例修改、模型变化与持久显示标记。
- 完整请求投影保持未修改 system/messages 的字节和顺序，原有测试覆盖工具及推理内容块；没有改动 provider tools 装配。
- 网页仅编辑设置、世界书及提交命令，不创建模板 iframe；opening 直接请求服务端初始化。
