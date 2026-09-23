import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';

// Bundled bootstrap for both first installation and an explicit Setup upgrade.
// The normal installed entry does not call this after a successful upgrade.
const resources=path.dirname(fileURLToPath(import.meta.url));
const data=path.resolve(process.argv[2]);
const home=path.join(data,'harness');
const source=path.join(home,'apps','dsh-tavern');
const hostRoot=path.join(resources,'app');
const log=path.join(data,'setup-upgrade.log');
fs.mkdirSync(data,{recursive:true});
try {
  if(process.env.DSH_ONLINE_TEST_OFFLINE==='1')throw Error('测试：网络不可用');
  const env={...process.env,DSH_HOME:home,DSH_TAVERN_HOST:'desktop',DSH_TAVERN_RUNTIME_HOST:'desktop',
    DSH_TAVERN_APP_DIR:source,DSH_DESKTOP_APP_EXECUTABLE:process.execPath,
    DSH_DESKTOP_DSH_BOOTSTRAP:path.join(hostRoot,'lib','desktop-cli.js'),
    DSH_TAVERN_HOST_DEPENDENCY_ANCHOR:path.join(hostRoot,'package.json'),
    CI:'true',pnpm_config_frozen_lockfile:'false',
    npm_config_cache:path.join(data,'cache','npm'),pnpm_config_store_dir:path.join(data,'cache','pnpm')};
  const {installDesktopDshRuntime}=await import(pathToFileURL(path.join(hostRoot,'lib','desktop-runtime-environment.js')));
  installDesktopDshRuntime({platform:'win32',appExecutable:process.execPath,dshBootstrapPath:env.DSH_DESKTOP_DSH_BOOTSTRAP,
    profileName:'tavern',homeDir:home,stateDir:path.join(data,'desktop','host-commands','tavern'),environment:env});
  const {prepareDesktopPackageManager}=await import('./desktop-package-manager.mjs');
  const manager=await prepareDesktopPackageManager({host:'desktop',home,env,onProgress:message=>console.log('DSH_STATUS '+message)});
  const pathKey=Object.keys(env).find(key=>key.toUpperCase()==='PATH')||'PATH';
  env[pathKey]=[path.dirname(manager.node),manager.bin,env[pathKey]].join(path.delimiter);
  for(const key of Object.keys(env))if(key.toUpperCase()==='ELECTRON_RUN_AS_NODE')delete env[key];
  // EncodedCommand avoids shell quoting and Windows PowerShell's ANSI script decoding.
  // Do not merge streams with *>&1 under ErrorAction Stop: native stderr (for example
  // Node's EnvHttpProxyAgent warning when NODE_USE_ENV_PROXY=1) becomes a terminating
  // ErrorRecord and aborts install. Node already redirects both powershell stdout and
  // stderr to the log; Write-Host still reaches that stdout when the console is redirected.
  env.DSH_SETUP_INSTALLER=path.join(resources,'install.ps1');
  const command="$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding; try { Invoke-Expression ([IO.File]::ReadAllText($env:DSH_SETUP_INSTALLER,[Text.Encoding]::UTF8)) } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }";
  console.log('DSH_STATUS 正在安装或更新最新版 Tavern，请等待…');
  const output=fs.openSync(log,'a');
  let code;
  try {
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-OutputFormat','Text','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],
      {env,windowsHide:true,stdio:['ignore',output,output]});
    code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});
  } finally {fs.closeSync(output)}
  if(code!==0)throw Error('安装或更新失败，请查看日志：'+log);
  // Older online installers may have left a pending first-install marker.
  fs.rmSync(path.join(source,'.portable-install-pending.json'),{force:true});
  console.log('DSH_STATUS Tavern 安装或更新完成');
} catch(error) {
  fs.appendFileSync(log,String(error.stack||error)+'\n');
  console.error(error.message);
  process.exitCode=1;
}
