import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import test from 'node:test'
import { parseDocument } from 'yaml'

import { ensureSidebarDefaults, isServiceReady } from '../bin/dsh-tavern.mjs'

const windowsInstaller = await readFile(new URL('../install.ps1', import.meta.url), 'utf8')
const unixInstaller = await readFile(new URL('../install.sh', import.meta.url), 'utf8')

const installationSource = await readFile(new URL('../bin/profile-installation.mjs', import.meta.url), 'utf8')
const updateSource = await readFile(new URL('../bin/application-update.mjs', import.meta.url), 'utf8')
const profilePatch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const managedProfilePatch = await readFile(new URL('../tavern-plugin/cordis.patch.yml', import.meta.url), 'utf8')
const profileConfigurationSource = await readFile(new URL('../bin/profile-configuration.mjs', import.meta.url), 'utf8')
const rootManifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

const tavernPluginManifest = JSON.parse(await readFile(new URL('../tavern-plugin/package.json', import.meta.url), 'utf8'))
const profileWorkspace = await readFile(new URL('../pnpm-workspace.yaml', import.meta.url), 'utf8')

test('Windows UI 更新隐藏 PowerShell 窗口并保持 UTF-8 输出', () => {
  assert.match(updateSource, /System\.Text\.UTF8Encoding/)
  assert.match(updateSource, /spawnSync\(command, args, \{[\s\S]*?windowsHide: true,/)
})

test('Tavern profile installs Better Sidebar as its right-panel foundation', () => {
  assert.equal(rootManifest.devDependencies['dsh-better-sidebar'], '0.19.1')
  assert.ok(rootManifest.dsh.profile.bundles.includes('dsh-better-sidebar'))
  assert.match(profileConfigurationSource, /managedDependencies/)
})

test('Tavern profile also installs the pinned mobile adaptation plugin', () => {
  assert.equal(
    rootManifest.devDependencies['dsh-web-mobile'],
    '2.3.0',
  )
  assert.ok(rootManifest.dsh.profile.bundles.includes('dsh-web-mobile'))
  assert.equal(rootManifest.dependencies['@dsh-external/dsh-mobile-nav'], undefined)
  assert.ok(rootManifest.dsh.profile.bundles.includes('dsh-better-sidebar'))
})

test('Tavern profile does not auto-install Better Sidebar peer dependencies over DSH built-ins', () => {
  assert.match(profileWorkspace, /^autoInstallPeers:\s*false$/m)
})

test('Tavern profile isolates conversations from other DSH profiles on fresh installs', () => {
  assert.match(managedProfilePatch, /id: session-persistence-jsonl[\s\S]*dshHomePath\('profile-data', 'tavern', 'sessions'\)/)
  assert.match(managedProfilePatch, /id: storage-json[\s\S]*dshHomePath\('profile-data', 'tavern', 'storages'\)/)
  assert.deepEqual(parseDocument(profilePatch).toJS(), [])
  assert.ok(rootManifest.dsh.profile.bundles.includes('dsh-tavern-plugin'))
  assert.equal(tavernPluginManifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.match(installationSource, /prepareProfilePatch/)
  assert.match(unixInstaller, /node "\$\{APP_DIR\}\/bin\/dsh-tavern\.mjs" install --host "\$\{INSTALL_HOST\}"/)
  assert.match(windowsInstaller, /Invoke-InstallCommand 'profile\.install' 'node' @\(\(Join-Path \$AppDir 'bin\\dsh-tavern\.mjs'\), 'install', '--host', \$InstallHost\)/)
})

test('Tavern sidebar migration marker与三个库设置写入 YAML', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-tavern-settings-'))
  t.after(async function () { await rm(directory, { recursive: true, force: true }) })
  const settingsPath = path.join(directory, 'settings.yaml')
  await writeFile(settingsPath, 'dsh-better-sidebar:\n  tabsEnabled:\n    editor: false\n', 'utf8')

  assert.equal(ensureSidebarDefaults(settingsPath), true)
  const written = await readFile(settingsPath, 'utf8')
  assert.match(written, /dsh-tavern:\n  sidebarDefaultsVersion: 8/)
  assert.match(written, /editor: true/)
  assert.match(written, /dsh-tavern:resources: true/)
  assert.match(written, /dsh-tavern:cards: true/)
  assert.match(written, /dsh-tavern:presets: true/)
  assert.doesNotMatch(written, /dsh-tavern:boundary-prompts/)
})

test('一键更新在依赖检查前复用 Tavern 托管运行时', () => {
  const windowsRuntimePath = windowsInstaller.indexOf('$env:Path = "$RuntimeRoot;$env:Path"')
  const windowsDependencyCheck = windowsInstaller.indexOf('$MissingPackages = @()')
  assert.ok(windowsRuntimePath >= 0)
  assert.ok(windowsRuntimePath < windowsDependencyCheck)

  const unixRuntimePath = unixInstaller.indexOf('PATH=${RUNTIME_BIN}:${PATH}')
  const unixDependencyCheck = unixInstaller.indexOf('  set --')
  assert.ok(unixRuntimePath >= 0)
  assert.ok(unixRuntimePath < unixDependencyCheck)
})

test('一键安装固定经过验证的 pnpm 主版本并可从不兼容版本恢复', () => {
  assert.match(windowsInstaller, /\$PnpmVersion = '11\.25\.0'/)
  assert.match(windowsInstaller, /"pnpm@\$PnpmVersion"/)
  assert.match(windowsInstaller, /--version/)
  assert.match(unixInstaller, /PNPM_VERSION=11\.25\.0/)
  assert.match(unixInstaller, /pnpm@\$\{PNPM_VERSION\}/)
  assert.match(unixInstaller, /pnpm --version/)
})

test('Desktop 安装复用内置运行时，不启动独立 3081 服务', () => {
  assert.match(unixInstaller, /INSTALL_HOST=\$\{DSH_TAVERN_HOST:-cli\}/)
  assert.match(unixInstaller, /install --host "\$\{INSTALL_HOST\}"/)
  assert.match(unixInstaller, /if \[ "\$\{INSTALL_HOST\}" = "desktop" \]/)
  assert.match(windowsInstaller, /\$InstallHost = if \(\$env:DSH_TAVERN_HOST\)/)
  assert.match(windowsInstaller, /'install', '--host', \$InstallHost/)
  assert.match(installationSource, /if \(host === 'cli'\) installCommand\(\)/)
  assert.match(installationSource, /请重启 DSH Desktop/)
})

test('一键安装先安装下载包依赖，再运行 Tavern 安装器', () => {
  const unixDependencies = unixInstaller.indexOf('pnpm --dir "${APP_DIR}" install --frozen-lockfile')
  const unixLauncher = unixInstaller.indexOf('node "${APP_DIR}/bin/dsh-tavern.mjs" install')
  assert.ok(unixDependencies >= 0)
  assert.ok(unixDependencies < unixLauncher)

  const windowsDependencies = windowsInstaller.indexOf("Invoke-InstallCommand 'dependencies.install' $PnpmCommand @('--dir', $AppDir, 'install', '--frozen-lockfile'")
  const windowsLauncher = windowsInstaller.indexOf("Invoke-InstallCommand 'profile.install' 'node'")
  assert.ok(windowsDependencies >= 0)
  assert.ok(windowsDependencies < windowsLauncher)
})

test('一键安装直接启动 Tavern，不通过包管理器托管后台进程', () => {
  assert.match(unixInstaller, /DSH_HOME=\$\{DSH_ROOT\} node "\$\{APP_DIR\}\/bin\/dsh-tavern\.mjs" start/)
  assert.doesNotMatch(unixInstaller, /pnpm --dir "\$\{APP_DIR\}" run start:tavern/)

  assert.match(windowsInstaller, /Invoke-InstallCommand 'service\.start' 'node' @\(\(Join-Path \$AppDir 'bin\\dsh-tavern\.mjs'\), 'start'\)/)
  assert.doesNotMatch(windowsInstaller, /& \$PnpmCommand --dir \$AppDir run start:tavern/)
})

test('升级后用户数据固定在 Profile 目录，并在安装时迁移旧源码数据', () => {
  assert.match(installationSource, /resolveTavernDataRoot\(\{ dshHome: DSH_ROOT \}\)/)
  assert.match(installationSource, /migrateLegacyTavernData\(\{/)
  assert.match(installationSource, /backupRoot: path\.join\(DSH_ROOT, 'backups', 'dsh-tavern-data-upgrade'\)/)
  assert.doesNotMatch(installationSource, /mkdirSync\(path\.join\(SOURCE_ROOT, 'data'/)
})

test('Web 服务就绪检查接受 alpha.2 鉴权响应', async () => {
  assert.equal(await isServiceReady(3081, async () => ({ ok: true })), true)
  assert.equal(await isServiceReady(3081, async () => ({ ok: false, status: 401 })), true)
  assert.equal(await isServiceReady(3081, async () => ({ ok: false })), false)
  assert.equal(await isServiceReady(3088, async () => ({ ok: false, status: 403 }), 'android'), true)
  assert.equal(await isServiceReady(3081, async () => ({ ok: false, status: 403 }), 'cli'), false)
  assert.equal(await isServiceReady(3088, async () => ({ ok: false, status: 500 }), 'android'), false)
  assert.equal(await isServiceReady(3081, async () => { throw new Error('offline') }), false)
})
