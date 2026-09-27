# Windows 启动器 preparing/app 访问拒绝排查

日期：2026-09-25。初始基线：main `f546c74e`，原工作区干净。最终构建前再次同步至 `2b391f4c`，保留本次本地修改。

**当前方案已取消五秒重试。** 最终实现直接在唯一的最终运行目录准备文件，以完整版本号 `ready` 标记提交；生产启动器不再调用 `Directory.Move`。下面保留初版实验历史，最终方案及验收见文末。

## 结论与边界

用户日志是 `System.IO.IOException`，调用栈为 `Directory.InternalMove → Launcher.Run`，路径止于 `preparing-*/app`。当前启动器对应步骤为：解压、运行 Electron Node 补丁并等待退出、移动 app 到版本化 runtime、写 ready。

已在本机 Windows/.NET Framework 复现相同异常、相同 InternalMove 堆栈和 `0x80070005`：只需 app 内一个文件以不共享删除的句柄打开。管理员权限并不能解除这种共享约束。微软文档说明 FILE_SHARE_DELETE 控制删除及重命名共享，句柄关闭前共享模式一直有效：[CreateFile](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilea)。

确定的代码缺陷：移动目录只尝试一次，暂时占用也直接终止整个准备流程；原始日志缺少目标目录、操作阶段、错误码和重试信息。

尚未确定：用户机器上实际占用者、文件系统和 ACL。安全软件扫描、其他持有句柄的进程是可能触发者，不是已确认事实。用户提供的日志没有 HRESULT；0x80070005 来自本地同症状复现。不能据此宣称所有报错都由杀毒软件引起，也未在用户 G 盘复测。

## 对照实验

最小探针位于 `D:/Workspace/dsh-launcher-access-diagnosis/Probe.cs`，执行 Probe.exe 时为每次运行指定新的目录。

| 条件 | 原始 Directory.Move 结果 |
| --- | --- |
| 普通目录 | 成功 |
| 源目录只读属性 | 成功 |
| 源目录内文件 FileShare.Read 打开 | IOException，0x80070005，源 app 路径访问拒绝 |
| 目标目录已存在 | IOException，0x800700B7，提示文件已存在；不是本次同症状 |

探针也尝试打开源目录句柄，该具体打开方式没有阻止移动；不能泛化为所有目录句柄均不影响移动。

## 初版修复及可重复验证（已由无目录移动方案替代）

将实际调用点提取为 PublishRuntime；先保持原始单次 Directory.Move，实现回归测试并观察失败，再添加修复：

- 仅对 Win32 5/32/33 错误重试，每 250ms 一次，最多 21 次尝试、约五秒等待。
- 保持目录移动的原子发布，不合并、不覆盖已有 runtime；仅移动成功后写 ready。
- 持续失败保留内部异常，补充阶段、版本、源/目标目录、次数、HRESULT 和处理提示。
- 不改运行时 payload、补丁或数据目录，不提升管理员权限，不修改 ACL、不禁用安全软件。

回归命令（测试目录必须不存在）：

```powershell
./packaging/windows/test-runtime-publish.ps1 -TestDirectory D:/Workspace/dsh-launcher-access-diagnosis/green
```

修复前：`FAIL: transient file lock recovers`，抛出 app 访问拒绝；`FAIL: persistent lock ...`，缺诊断；已有目录保护通过。

修复后：三项均 PASS。测试调用与 Run 相同的真实 PublishRuntime 方法，在文件句柄持有期间先确认旧 Directory.Move 确实抛 0x80070005；600ms 后释放句柄，修复路径成功。持续占用在有限等待后失败，释放后可重试；已有目标立即失败且内容不变。

完整安装回归：

```powershell
./packaging/windows/test.ps1 -Launcher D:/Workspace/dsh-launcher-access-diagnosis/DSH-Tavern-Setup-access-fix.exe -TestDirectory D:/Workspace/dsh-launcher-access-diagnosis/integration
```

全部通过：实际 payload 解压及补丁、中文路径下 dsh/pnpm/node、稳定启动入口与快捷方式、下载包移走后启动、旧数据保留、外部数据目录、断网失败保留入口与日志、缺失数据不被重建。测试系统入口及注册表按现有测试机制隔离。没有执行联网完整游戏验收，也未验证特定第三方安全软件。

## 初版本地交付（历史产物）

安装包：`D:/Workspace/dsh-launcher-access-diagnosis/DSH-Tavern-Setup-access-fix.exe`。

SHA-256：`31868406C7755BB10F8B7633C6CC793F7533D8D3BB45156338E258F265DB57E2`。

这是本地修复候选包，未提交、推送或替换公开下载。安装器流程未变，仍会联网安装/更新酒馆。仅替换仓库代码不会修复用户已经下载的旧 EXE，需要交付重新构建的安装包。

若修复包仍在此步骤失败，应收集新 launcher-error.txt，并在失败时检查源目录相关的进程句柄、安全软件拦截记录及安装目录权限。五秒以上的持续占用和真实访问策略需要处理实际阻止者；不能承诺有限重试会消除这些情况。不建议用户反复提权或删除 data。

## 补充：本地联网安装与覆盖安装实测

2026-09-25 16:39–16:48（北京时间）使用同一修复 EXE 在 `D:/Workspace/dsh-launcher-access-diagnosis/reinstall-live` 执行真实联网安装，测试进程未提权。使用 DSH_LAUNCHER_TEST_ROOT 隔离系统快捷方式与注册表，并指定 `--tavern-smoke` 在准备实际 Desktop Profile 后自动退出；未进行游戏界面或模型对话验收。

- 首次安装：退出码 0；实际从 main 安装 `f546c74e26efd0263e5a46b51758dd4a75105d71`；Tavern 2.2.0、Desktop 2.0.13；没有发生 preparing/app 移动失败。
- 同目录覆盖安装：将本测试安装的 `.launcher-upgrade-ready` 移到备份位置，触发真实更新流程；保留旧 runtime。测试数据哨兵与 launcher-settings.xml 使用 SHA-256 比较。
- 第一轮覆盖安装：pnpm 输出 `Done in 623ms` 后进程仍等待数分钟，尚未自然退出；之后附加诊断。关闭诊断连接的测试代码因 `require is not defined` 导致该进程退出，故最终退出码 1 受诊断操作影响，不能当作产品自然失败的证据。诊断前等待本身确实存在，原因未定。
- 不附加诊断重新运行：10.7 秒完成，退出码 0；新生成 smoke-result.json 的 ok=true；数据哨兵、目录配置哈希均不变；成功标记存在，launcher-error.txt 已清除。
- 安装目录失效时的取消、重装和恢复原目录回归另行通过。

机器可读结果：`D:/Workspace/dsh-launcher-access-diagnosis/reinstall-live/reinstall-result.json`；首次自检快照：`first-install-smoke.json`；完整安装日志：`data/setup-upgrade.log`。本次保留这一测试安装供复核。结论为本机首次安装及一次干净重试覆盖安装通过，并不表示 pnpm 偶发退出等待已经修复。

## 最终方案：删除容易失败的目录移动步骤

五秒重试只能处理短暂占用。对持续文件占用，增加重试时间不能消除故障，因此改为：

1. 在原有准备互斥锁内，优先选择相同版本的已完成运行目录；兼容原 `runtime-<版本>`。
2. 如无可用目录，为本次尝试生成 `runtime-<版本>-<随机编号>`，直接在其中解压和执行补丁。目录自始至终不改名。
3. 解压校验、补丁进程全部成功且主程序存在后，才写完整版本号 `ready`。下次启动必须验证标记内容完全匹配且主程序存在。
4. 没有标记、标记截断、版本不符或缺少主程序的目录均不启动。失败时尽力清理本次目录，不能清理也不妨碍下次使用新的独立目录；原始异常保留。
5. 快捷方式指向本次选定的运行目录。已有完成目录不被覆盖、不重新打补丁，用户数据位置不变。

该方案消除了“目录内文件未共享删除 → 整目录移动失败”这条故障路径，不需要用户提高权限，也不等待锁释放。真实的文件写入禁止、执行拦截或磁盘故障仍可能阻止安装；这些不能靠更换目录发布方法保证消除。

### 最终回归证据

- 快速回归：`test-runtime-publish.ps1`。保留移动/重试的对照实现遇到持续占用时报 0x80070005；取消移动后五项全部通过，包括持续占用下不到一秒完成、失败清理受阻后新目录重试、截断标记/缺失主程序/错误版本拒绝、旧目录复用、标记写入失败保护。
- 真实安装包对照：`test-runtime-lock.ps1`。解压过程中打开 `DSH Desktop.exe` 并持续持有不共享删除的文件句柄。初版安装包在五秒重试后失败；最终包在同样条件下成功完成真实 payload 解压和补丁。保持句柄不释放，再次执行安装入口也成功，并确认复用同一目录、ready 未改写及快捷方式图标路径正确。最终包测试使用中文目录。
- `test.ps1` 全部通过：中文路径 dsh/pnpm/node、入口与快捷方式、下载包移走后启动、旧数据及外部数据保留、断网失败可重试、缺失数据不重建。
- 在仅改变目录布局、尚未提升内部版本的中间构建中，对先前真实联网测试安装执行离线启动自检成功，确认可复用旧式同版本目录。最终 `setup3` 因安装脚本升级会准备新运行目录；同版本旧式目录兼容继续由快速回归覆盖。

### 最终本地产物

`D:/Workspace/dsh-launcher-access-diagnosis/DSH-Tavern-Setup-no-directory-move.exe`

SHA-256：`B50BA31D7EFD92123341DF055AC85F761980F4917CA02FE2EC1DC124701DBDF7`。

发布文件名：`DSH-Tavern-Desktop-2.0.13-x64-Setup3.exe`，挂载于 v2.2 发布页。需用这个新安装包替换旧版下载，仓库代码修改本身不会改变用户已下载的 EXE。payload/Desktop/DSH 核心保持不变；内置安装脚本更新，因此运行时后缀升为 `setup3`，旧目录保留。

### 联网验收发现的安装清单变化

测试期间 main 从 f546c74e 更新到 2b391f4c，新增 `patchedDependencies` 和 `patches/dsh-better-sidebar@0.19.1.patch`。先前构建的 EXE 内嵌旧 install.ps1，虽然下载了新的 pnpm 配置，却没有归档 patches，导致 ENOENT。此异常与目录移动无关。

最新主分支已在 Windows/Unix 安装清单及运行清单中包含 patches。同步最新代码重新打包，并将内部版本升为 setup3，保证新包不复用 setup2 目录中的旧安装器。最终验收显式固定源提交 2b391f4c，避免远端在测试期间继续变化。

最终 setup3 在独立的 `D:/Workspace/dsh-launcher-access-diagnosis/setup3 持续占用` 目录完成真实联网安装，`test-online-upgrade.ps1` 返回 PASS：Tavern 2.2.0 / Desktop 2.0.13，数据哨兵保留、启动自检成功。Node 下载曾超时，随后复用前次下载且与官方 SHA-256 一致的 Node 22.22.3 缓存；npm 包正常执行真实下载，react-icons 下载重试后完成。

对先前已有完整 Profile 的另一测试安装执行升级时，再次出现 pnpm 输出 Done 后不退出，后续仅终止本测试的卡住进程，让安装器报失败；此路径没有计为通过。它发生在运行目录已准备完成之后，属于独立未解决问题。不能把本次 Directory.Move 故障路径的消除表述为所有安装故障均已解决。

## 国内 npm 镜像与工作区保留

用户随后要求拉取最新远端并保留本地改动。再次 fetch 确认 origin/main 仍为 2b391f4c，快进合并返回 Already up to date；本地修改未覆盖。tracked diff 和未跟踪测试/报告的副本保存在 D 盘本任务目录。

正式 install.ps1、install.sh 和 CLI runtime 原本默认 npmmirror；此前联网回归脚本却强制 registry.npmjs.org，因此实测走了官方源。已改为默认 `https://registry.npmmirror.com`，支持参数或 DSH_TAVERN_NPM_REGISTRY 显式覆盖，结束恢复环境。直接运行安装命令的子进程环境也统一默认镜像，并消除 Windows 大小写重复配置键；不改用户全局 npm 配置。

镜像配置及 Windows 命令回归 8 项全部通过。附加执行的 CLI 测试中，Windows 场景通过；Linux 符号链接场景在本机普通 Windows 权限下因 EPERM 失败，未算作通过，也未为此改动产品代码。

国内镜像实下载：`npm pack react-icons@5.7.0 --registry=https://registry.npmmirror.com --ignore-scripts` 成功，元数据来自 registry.npmmirror.com，22,766,600 字节 tarball 来自 cdn.npmmirror.com，下载约 40.7 秒，退出码 0；实际文件 SHA-512 与项目 pnpm-lock.yaml 中的 integrity 一致。材料和日志在 `D:/Workspace/dsh-launcher-access-diagnosis/npm-mirror-check`。

最终独立安装再次执行禁用联网升级的启动自检通过，确认复用 setup3 的唯一最终目录，没有重复解压。

冗余测试目录的递归清理被自动审批策略拦截（仅返回 blocked by policy），因此保留副本；未绕过策略删除。
