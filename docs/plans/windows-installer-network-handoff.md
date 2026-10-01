# 交接：Windows 一键安装的网络问题

日期：2026-10-01
状态：已诊断，未改代码。

## 背景：用户报错

Windows 一键安装（Setup EXE）反复弹出：

```
启动失败：The operation was aborted due to timeout
文件位置：E:\dsh tavern\DSH-Tavern
```

点"重试"无效。

### 已确认的直接原因

- README 的下载链接仍指向 v2.2 的 `DSH-Tavern-Desktop-2.0.13-x64-Setup3.exe`（2026-09-25 17:29 上传）。
- 该 EXE 内嵌的 `bin/desktop-package-manager.mjs` 早于 `0a8a8076`（09-25 17:31），只从 nodejs.org 下载约 80MB 的 `node.exe`，总时长上限 120 秒，失败不重试，`TimeoutError` 原样抛出。经 `setup-upgrade.mjs` 的 `console.error(error.message)` 和 `Launcher.cs:92` 弹窗，用户看到的就是这句英文。
- 新代码已经加上本机复用、npmmirror 备用源、重试和中文提示，`Launcher.cs` 的版本也升到了 `a272f20b3f1f5b15-setup4`。但 v2.3、v2.4 都没有上传 EXE，CI 也不出安装包，修复没有送到用户手里。

## 任务 1（优先）：Windows 上 pnpm 改用 Desktop 自带的 Electron

用户的决定：不把 node.exe 打进安装包（不想让 EXE 增大约 30MB），希望 pnpm 直接复用 DSH Desktop 自带的运行时。

### 现状

- Desktop 没有独立的 node.exe，只有 Electron 主程序 `DSH Desktop.exe`，设置 `ELECTRON_RUN_AS_NODE=1` 后可以当 Node 用（Electron 43.3.0 / Node 24.18.1）。`setup-upgrade.mjs` 和 `install.ps1` 里的 `node` 都是它。
- `1f049ddb`（2026-09-22，fix(windows): isolate Desktop package management from Electron）引入了以下隔离：
  - `bin/desktop-package-manager.mjs`：下载并校验独立的 Node 22.22.3，生成 `pnpm-runner.cjs` 和 `pnpm.cmd`。
  - `packaging/windows/patch-runtime.cjs`：把 Desktop 自带的 `pnpm.mjs` 替换成转接桥，遇到 install、add 等命令时改用独立 Node 运行。
  - `install.ps1` 的 `desktop.package-manager` 步骤，以及 `bin/profile-installation.mjs` 中的相关调用。
- 隔离的唯一依据是 `patch-runtime.cjs:10` 的一句注释："Package management must not run worker threads inside Electron on Windows."。提交说明为空，没有对应的 issue、复现记录或测试。
- 反面证据：
  - Desktop 自带 pnpm 11.8.0，平时就用 Electron 运行它。
  - `docs/research/issue-40-status.md` 记录过：在 Mac 上用 Electron 43 当 Node 跑 pnpm，能正常退出。
  - 推测（未证实）：当年看到的现象可能是"卡在正在更新"，而真正的原因是 09-17 已修复的 pnpm 版本检查挂起（`pnpm_config_update_notifier=false`）。
- pnpm 至少开 1 个 worker 线程，`PNPM_MAX_WORKERS` 无法设为 0（见 pnpm.mjs 中的 `calcMaxWorkers`）。所以如果 Windows 上的问题真实存在，没有办法绕开。

### 步骤

1. **先在 Windows 上验证**。可以在 `.github/workflows/launcher.yml` 加一个 `windows-latest` 任务，或者提供一条真机命令给用户跑：
   - 运行时用 Desktop 2.0.13 的 Windows 版，下载来源参考 `packaging/windows/build-payload.ps1`。
   - 用 `DSH Desktop.exe` 加 `ELECTRON_RUN_AS_NODE=1` 运行 Desktop 自带的 pnpm（**不打转接补丁**），执行 `pnpm --dir <Tavern> install --frozen-lockfile`。
   - 环境变量和 `install.ps1` 保持一致：`npm_config_registry` 设为 npmmirror，`pnpm_config_update_notifier=false`。
   - 空缓存跑一次、有缓存跑一次，各重复 3 轮以上，加超时；检查退出码，以及打印 Done 之后进程是否退出。
   - 可参考现有的 `packaging/windows/test-package-manager.mjs`。
2. **通过后**：删掉独立 Node 这一整套，包括 node.exe 下载、`patch-runtime.cjs` 的转接桥、`desktop.package-manager` 步骤，以及 `setup-upgrade.mjs` 里 `prepareDesktopPackageManager` 的调用和 PATH 拼接。同步更新 `docs/installation.md`、`packaging/windows/README.md` 和相关测试。
   - 注意 `bin/desktop-package-manager.mjs` 还被 `install.ps1`（普通 Desktop 的安装命令）和 `profile-installation.mjs` 用到，几处要一起改。
   - 已有安装目录里的 `harness/tools/desktop-package-manager` 可以留着不管，不要去删用户的文件。
3. **没通过**：把具体现象（崩溃、挂起还是报错，附输出）写进文档，再和用户确定退路：改成先用 npmmirror，或者把 node.exe 打进安装包。

## 任务 2：网络健壮性（和任务 1 无关，都要做）

### 2.1 系统代理不生效（影响最大）

- Node fetch、curl.exe、git、pnpm 都只认 `HTTP(S)_PROXY` 环境变量，不读 Windows 系统代理。Clash 等工具默认用"系统代理"模式，GitHub、nodejs.org 的请求照样直连，照样超时。
- `Launcher.cs:268` 设了 `NODE_USE_ENV_PROXY=1`，但整个仓库都没有读取系统代理的代码。
- 建议：
  - 在 Launcher 启动 `setup-upgrade` 之前，如果环境里没有 `HTTPS_PROXY`、`HTTP_PROXY`（大小写都要查），就读取系统代理（`WebRequest.GetSystemWebProxy().GetProxy(uri)`，或者注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` 的 `ProxyEnable`、`ProxyServer`），注入 `HTTP_PROXY`、`HTTPS_PROXY`，同时设置 `NO_PROXY=localhost,127.0.0.1`。
  - git 认 `HTTPS_PROXY`，curl 认 `HTTPS_PROXY`，pnpm 认 `https_proxy` 或 `pnpm_config_https_proxy`，要逐个确认。
  - PAC 自动配置无法这样转换，在文档里说明即可。
  - 注意 `Launcher.cs` 里 `RepairDuplicateEnvironmentVariables` 处理的大小写重名问题，不要再引入同名变量。

### 2.2 用"总时长上限"冒充"卡住检测"

网速慢但没断的用户会每次都失败：

| 位置 | 内容 | 上限 | 需要的最低速度 |
|---|---|---|---|
| `bin/desktop-package-manager.mjs` | node.exe，约 80MB | `AbortSignal.timeout(120000)` | 约 700 KB/s |
| `install.ps1` 的 `Invoke-SourceDownload` | codeload 压缩包，13.5MB | curl `--max-time 120`，3 次 | 约 115 KB/s |
| `install.ps1` 的 CDN 下载脚本 | jsDelivr 单文件，最大 6.7MB；共 930 个文件、48MB | 单文件 30 秒，总预算 5 分钟 | 约 220 KB/s |

改法：改成"连续 N 秒（例如 30 秒）没收到数据才算失败"，再配一个宽松的总上限。curl 用 `--speed-limit`、`--speed-time` 替代 `--max-time`；fetch 读取响应体时，每收到一块数据就重置计时器。

如果任务 1 通过，第一行会随独立 Node 一起删除；没通过的话，还要把下载顺序改成 npmmirror 优先（有 SHA-256 校验，换源安全）。

### 2.3 出错时信息丢失

`packaging/windows/setup-upgrade.mjs` 失败时只输出 `error.message`，看不出是哪一步、哪个地址。

建议：
- 给每个阶段标上名字。
- 弹窗显示"阶段 + 原因 + 日志路径"，并且把英文的 `TimeoutError`、`ECONNRESET` 等翻成中文。
- 完整堆栈和 `cause` 链写进 `setup-upgrade.log`。

## 任务 3：发布

- 打包用 GitHub Actions 的 `Windows Setup` 工作流（`.github/workflows/windows-setup.yml`）：从上游 Desktop 2.0.13 Setup 构建 payload，`build.ps1` 自动注入 payload 哈希，产出的 EXE 在 Actions 产物里下载。之后上传到 release，再把 README 第 82 行的下载链接改过去。
- 同一工作流里的 `Probe pnpm under Desktop Electron` 步骤就是任务 1 的 Windows 验证，看它的输出即可。
- 上传 release 是对外发布，必须先得到用户确认。
- 防止再犯：在 CI 里加检查，`Launcher.cs` 的 `Version` 与 README 链接指向的安装包不一致时报错；或者让 CI 在发布时自动构建并上传 EXE。

## 已查过、没问题的

- git 用 `--filter=blob:none --depth 1` 部分克隆后执行 `git archive`：实测只会批量补拉一次缺失文件，`-c http.lowSpeed*` 也会传给子进程。
- pnpm：lockfile 的 279 个依赖全部从 registry 解析，没有 GitHub tarball 或 git 依赖；registry 是 npmmirror。
- `node-pty` 已用 `allowBuilds: false` 禁止编译，不会去下载 Electron headers。
- Electron 自带 Node 24.18 和独立 Node 22.22.3 都支持 `NODE_USE_ENV_PROXY`。
- Desktop 的 `installDesktopDshRuntime` 不联网。
- `packaging/windows/online-install.mjs` 已不是安装入口（仅 `build-payload.ps1` 复制进 payload），可以考虑删除。

## 约定

- 每个功能点或修复单独提交，提交不加 Claude 署名，只有用户说"推送"才 push。
- 相关文件：`packaging/windows/{Launcher.cs,setup-upgrade.mjs,patch-runtime.cjs,build.ps1,build-payload.ps1,test-package-manager.mjs}`、`bin/desktop-package-manager.mjs`、`bin/profile-installation.mjs`、`install.ps1`、`docs/installation.md`、`packaging/windows/README.md`、`.github/workflows/launcher.yml`。
