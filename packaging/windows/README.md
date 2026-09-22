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
- 实验构建的 `online-install.mjs` 默认从 `experiment/plugin-session-patch` 拉取酒馆；合并 main 后应改回 `main`。
- 旧 runtime 保留用于回退；不自动清理用户历史运行时和数据。新版首次准备需要额外磁盘空间。

发布时先上传新的 `Setup.exe` 附件并核对哈希，再发布 README 新链接。保留旧 `Portable.exe` / Setup，避免覆盖旧地址和丢失可复核的构建输入。

重装回归：运行 `./packaging/windows/test-reinstall.ps1 -TestDirectory D:/build/reinstall-test`。测试副本仅替换注册表读取，使用实际安装选择流程和窗体验证旧目录缺失时取消、重新安装及恢复原数据路径，不修改用户注册表。

Windows 包管理修复：`setup1` 在新运行时中加入 pnpm 入口桥，包管理使用安装目录内经过官方 SHA-256 校验的独立 Node；保留 Desktop 及 DSH 适配版本。`bin/desktop-package-manager.mjs` 同时供普通 Desktop 安装脚本与 Profile 安装使用，CLI 和非 Windows 平台跳过。

真实入口回归：`node packaging/windows/test-package-manager.mjs <解压后的运行时目录> <新的测试目录>`，验证依赖安装退出和失败退出码。首次会下载校验后的 Node。
