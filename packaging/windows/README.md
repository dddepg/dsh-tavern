# Windows 安装入口

这里维护一键安装 EXE 的外层启动器。Desktop 固定为 2.0.13（内置 DSH `0.1.5-rc.2`），首次联网安装 Tavern，已有数据继续留在原位置。

## 构建

需要 Windows x64 和系统 .NET Framework C# 编译器，不需要安装 SDK。所有输入、测试和输出建议放在 D 盘独立目录。

从上游 Desktop Setup 生成在线安装 payload，再编译外层启动器：

```powershell
# 1) 下载 DSH-Desktop-2.0.13-x64-Setup.exe，并准备 7za.exe（可从旧 Portable 抽出）
./packaging/windows/build-payload.ps1 `
  -DesktopSetup D:/build/DSH-Desktop-2.0.13-x64-Setup.exe `
  -SevenZip D:/build/inputs/7za.exe `
  -OutputPayload D:/build/inputs/online-payload.7z `
  -WorkDirectory D:/build/payload-work

# 2) 将上一步输出的 SHA256 写入 build.ps1 / extract-build-inputs.ps1 / Launcher.cs
# 3) 编译 Setup.exe
./packaging/windows/build.ps1 -Payload D:/build/inputs/online-payload.7z -SevenZip D:/build/inputs/7za.exe -Output D:/build/DSH-Tavern-Desktop-2.0.13-x64-Setup.exe
./packaging/windows/test.ps1 -Launcher D:/build/DSH-Tavern-Desktop-2.0.13-x64-Setup.exe -TestDirectory D:/build/new-test-directory
```

也可继续从已发布的 Portable/Setup 中抽取 `online-payload.7z` 与 `7za.exe`：

```powershell
./packaging/windows/extract-build-inputs.ps1 -Launcher D:/build/Setup.exe -Destination D:/build/inputs
```

`test.ps1` 会在独立目录真实解压 EXE、读写 Windows 快捷方式，并测试中文路径、下载包移走、旧数据保留、入口补建、断网重试入口和数据目录缺失。桌面、开始菜单写入被 `DSH_LAUNCHER_TEST_ROOT` 隔离到测试目录，不修改真实系统入口或注册表。传入的测试目录必须尚不存在。`--prepare-only` 仅准备运行时和入口；`--tavern-smoke` 联网完成安装后检查实际 Desktop Profile，并写入数据目录下的 `smoke-result.json`。

## 启动与兼容

- `DSH Tavern.exe` 是持久启动入口；快捷方式和 Electron relaunch 都指向它。下载目录里的安装包不参与后续启动。
- `launcher-settings.xml` 记录真实数据目录；当前用户的 `HKCU\Software\DSH-Tavern\InstallRoot` 仅记录程序根目录。运行已安装入口时优先使用入口旁的配置。
- 识别旧版 `%LOCALAPPDATA%\DSH-Tavern-Portable`、`D:\Workspace\.DSH-Tavern` 和 `%LOCALAPPDATA%\DSH-Tavern`。旧数据不移动、不复制、不按新目录重置。已记录的程序目录失效时，提供选择原目录、重新安装或取消；明确选择重新安装后才进入安装位置选择，不自动清除注册表或删除旧文件。配置中已记录的数据目录缺失仍阻止启动，避免误建空白数据。
- 首次运行显示安装目录选择；旧版修复固定原位置，明确告知不迁移。每次启动会补建快捷方式。
- Desktop 2.0.13 使用 `resources/app` 目录布局，并已自带 UTF-8 代码页 prologue。`patch-runtime.cjs` 只注入 Windows 包管理隔离桥，并在新解压运行时内写入 ready 标记前执行。运行时版本后缀变更可避免修改正在运行的旧版文件；改补丁时必须同步提升后缀。
- `setup2` 使用随安装包嵌入的 `setup-upgrade.mjs` 和 PowerShell 安装器，从 `main` 安装或更新 Tavern。旧 payload 中的实验性 `online-install.mjs` 不再作为安装入口。
- `setup3` 取消准备完成后的整目录移动，并内置包含 `patches/` 的新版安装清单。安装包嵌入的补丁、安装脚本或包管理辅助文件变化时都须提升运行时后缀，避免复用旧目录中的过期脚本。
- 显式运行安装包时，即使已有 Tavern 也会执行更新。升级先关闭所选安装根目录下的 Desktop 进程（先请求关闭，等待十秒后结束残留托盘进程），不操作其他安装；安装页面提醒用户先保存操作。
- 数据目录中的 `.launcher-upgrade-ready` 只在成功后记录当前启动器版本。安装失败清除旧标记，下一次可重试；正常使用已成功升级的安装入口无需联网。新启动器首次运行也会执行一次升级，以补齐旧 Profile 的宿主依赖。
- 旧 runtime 保留用于回退；不自动清理用户历史运行时和数据。新版首次准备需要额外磁盘空间。

发布时先上传新的 `Setup.exe` 附件并核对哈希，再发布 README 新链接。保留旧 `Portable.exe` / Setup，避免覆盖旧地址和丢失可复核的构建输入。

重装回归：运行 `./packaging/windows/test-reinstall.ps1 -TestDirectory D:/build/reinstall-test`。测试副本仅替换注册表读取，使用实际安装选择流程和窗体验证旧目录缺失时取消、重新安装及恢复原数据路径，不修改用户注册表。

运行时直接在独立的 `runtime-<版本>-<随机编号>` 最终目录中解压与打补丁，不再移动包含运行文件的目录，也不依赖文件占用重试。全部准备成功后才写入内容为完整版本号的 `ready`；启动器在准备互斥锁内选择已完成目录，兼容原来的 `runtime-<版本>`。中断目录、截断标记和缺少主程序的目录不会被选中，重试使用新目录；失败目录尽力清理，清理失败不掩盖原始异常。已完成运行时不覆盖、不重新打补丁。

运行时发布回归：运行 `./packaging/windows/test-runtime-publish.ps1 -TestDirectory D:/build/publish-test`，验证持续文件占用下无需等待即可完成发布、中断恢复、旧目录兼容和标记写入失败保护。完整安装包回归：`./packaging/windows/test-runtime-lock.ps1 -Launcher D:/build/Setup.exe -TestDirectory D:/build/lock-test`，在真实解压期间持续锁定 EXE，直到准备及下一次启动入口均完成；同一测试可以复现旧安装包的 `Directory.Move / 0x80070005` 失败。此设计消除了整目录移动的共享锁故障，不绕过文件读取/写入/执行权限或安全软件明确拦截。

Windows 包管理修复：`setup1` 在新运行时中加入 pnpm 入口桥，包管理使用安装目录内经过官方 SHA-256 校验的独立 Node；保留 Desktop 及 DSH 适配版本。`bin/desktop-package-manager.mjs` 同时供普通 Desktop 安装脚本与 Profile 安装使用，CLI 和非 Windows 平台跳过。

真实入口回归：`node packaging/windows/test-package-manager.mjs <解压后的运行时目录> <新的测试目录>`，验证依赖安装退出和失败退出码。首次会下载校验后的 Node。

升级回归：`test-upgrade.ps1 -Launcher <安装包> -Runtime <准备后的运行时> -TestDirectory <空测试目录>` 检查旧插件不被跳过、失败重试、离线启动及进程关闭范围。`test-online-upgrade.ps1 -InstallDirectory <仅经过 prepare-only 的独立测试安装目录>` 执行联网覆盖安装，检查版本、数据哨兵和 Desktop smoke；不要对用户安装执行该测试。

安装器、直接安装命令及联网回归默认使用国内 npm 镜像 `https://registry.npmmirror.com`。需要其他源时设置 `DSH_TAVERN_NPM_REGISTRY`；联网回归也支持 `-Registry <URL>`，结束后恢复调用者的环境设置，不修改系统全局 npm 配置。
