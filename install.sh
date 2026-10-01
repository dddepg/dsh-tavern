#!/bin/sh

set -eu

# Inherit the registry throughout bootstrap, Profile and plugin installation.
export npm_config_registry="${DSH_TAVERN_NPM_REGISTRY:-https://registry.npmmirror.com}"
# pnpm 11 reads pnpm_config_* instead of npm_config_*.
export pnpm_config_registry="$npm_config_registry"
# Optional pnpm version checks must not hold a completed installation open.
export pnpm_config_update_notifier=false

INSTALL_HOST=${DSH_TAVERN_HOST:-cli}
case ${INSTALL_HOST} in
  cli|desktop) ;;
  *) echo "安装失败：不支持的安装宿主 ${INSTALL_HOST}" >&2; exit 1 ;;
esac

REPOSITORY=${DSH_TAVERN_REPOSITORY:-flizzywine/dsh-tavern}
REPOSITORY_URL=${DSH_TAVERN_GIT_URL:-https://github.com/${REPOSITORY}.git}
ARCHIVE_URL=${DSH_TAVERN_ARCHIVE_URL:-https://codeload.github.com/${REPOSITORY}/tar.gz/refs/heads/main}
COMMIT_URL=${DSH_TAVERN_COMMIT_URL:-https://api.github.com/repos/${REPOSITORY}/commits/main}
CDN_METADATA_URL=${DSH_TAVERN_CDN_METADATA_URL:-https://cdn.jsdelivr.net/gh/${REPOSITORY}@main/dsh-tavern-runtime.json}
CDN_ROOT_URL=${DSH_TAVERN_CDN_ROOT_URL:-https://cdn.jsdelivr.net/gh/${REPOSITORY}}
LEGACY_DSH_ROOT=${DSH_TAVERN_LEGACY_DSH_HOME:-${DSH_HOME:-${HOME}/.dsh}}
DSH_ROOT=${DSH_HOME:-${HOME}/.dsh}
if [ "${INSTALL_HOST}" = "cli" ]; then
  # CLI directory selection: explicit paths and existing installations never prompt.
  DSH_ROOT=${DSH_TAVERN_CLI_HOME:-}
  if [ -z "$DSH_ROOT" ]; then
    if [ -f "$PWD/apps/dsh-tavern/.dsh-tavern-local.json" ] || [ -f "$PWD/.dsh-tavern-install-root" ]; then
      DSH_ROOT=$PWD
    elif [ -f "$HOME/.dsh-tavern/apps/dsh-tavern/.dsh-tavern-local.json" ] || [ -f "$HOME/.dsh-tavern/.dsh-tavern-install-root" ]; then
      DSH_ROOT=$HOME/.dsh-tavern
    else
      if ! ( : </dev/tty ) 2>/dev/null; then
        echo '无法交互选择安装目录。请设置 DSH_TAVERN_CLI_HOME 后重新运行。' >&2
        exit 1
      fi
      printf '\n请选择 CLI 安装目录：\n  1. 默认目录：%s/.dsh-tavern\n  2. 当前目录：%s（回车默认）\n  3. 其他目录\n程序、运行时和游戏数据存入所选目录；命令入口和包管理器缓存可能位于目录外。\n' "$HOME" "$PWD" >/dev/tty
      while :; do
        printf '请选择 [1/2/3，默认 2]：' >/dev/tty
        IFS= read -r choice </dev/tty || exit 1
        case "$choice" in
          1) DSH_ROOT=$HOME/.dsh-tavern; break ;;
          2|'') DSH_ROOT=$PWD; break ;;
          3) printf '请输入完整安装路径：' >/dev/tty
             IFS= read -r DSH_ROOT </dev/tty || exit 1
             case "$DSH_ROOT" in /*) break ;; *) echo '请输入绝对路径。' >/dev/tty ;; esac ;;
          *) echo '请输入 1、2 或 3。' >/dev/tty ;;
        esac
      done
    fi
  fi
  case "$DSH_ROOT" in /*) ;; *) DSH_ROOT=$PWD/$DSH_ROOT ;; esac
  if [ ! -f "$DSH_ROOT/apps/dsh-tavern/.dsh-tavern-local.json" ] && [ ! -f "$DSH_ROOT/.dsh-tavern-install-root" ]; then
    for entry in apps runtime tools profiles profile-data source-cache logs backups settings.yaml; do
      if [ -e "$DSH_ROOT/$entry" ] || [ -L "$DSH_ROOT/$entry" ]; then
        echo "安装目录存在冲突：${DSH_ROOT}/${entry}。请选择空目录，或使用原有安装目录。" >&2
        exit 1
      fi
    done
  fi
  printf 'CLI 安装目录：%s\n' "$DSH_ROOT"
  mkdir -p "$DSH_ROOT"
  printf 'cli-v1\n' > "$DSH_ROOT/.dsh-tavern-install-root"
  DSH_TAVERN_CLI_HOME=${DSH_ROOT}
  DSH_TAVERN_LEGACY_DSH_HOME=${LEGACY_DSH_ROOT}
  export DSH_TAVERN_CLI_HOME DSH_TAVERN_LEGACY_DSH_HOME
fi
DSH_HOME=${DSH_ROOT}
export DSH_HOME
APP_DIR=${DSH_TAVERN_APP_DIR:-${DSH_ROOT}/apps/dsh-tavern}
RUNTIME_ROOT=${DSH_ROOT}/tools
RUNTIME_BIN=${RUNTIME_ROOT}/bin
PNPM_VERSION=11.25.0
COMMAND_BIN=${HOME}/.local/bin
SOURCE_CACHE=${DSH_ROOT}/source-cache/dsh-tavern.git
RUNTIME_PATHS='package.json pnpm-lock.yaml pnpm-workspace.yaml cordis.patch.yml install.ps1 install.sh bin config presets patches tavern-plugin'
TMP_BASE=${TMPDIR:-/tmp}
TMP_BASE=${TMP_BASE%/}
TEMP_DIR=$(mktemp -d "${TMP_BASE}/dsh-tavern-install.XXXXXX")
TARGET_COMMIT=${DSH_TAVERN_TARGET_COMMIT:-}

INSTALL_COMPLETED=0
cleanup() {
  install_exit=$1
  # Older macOS sh can report zero after a nounset error inside a conditional.
  if [ "$install_exit" -eq 0 ] && [ "${INSTALL_COMPLETED:-0}" -ne 1 ]; then install_exit=1; fi
  trap - EXIT HUP INT TERM
  if command -v update_log >/dev/null 2>&1; then update_log installer.finished bootstrap "$install_exit" '' ''; fi
  case "${TEMP_DIR}" in
    "${TMP_BASE}"/dsh-tavern-install.*) rm -rf -- "${TEMP_DIR}" ;;
  esac
  exit "$install_exit"
}
trap 'cleanup "$?"' EXIT HUP INT TERM

fail() {
  echo "安装失败：$1" >&2
  exit 1
}

if ! command -v node >/dev/null 2>&1; then
  echo "需要先安装 Node.js 22.19 或更高版本：https://nodejs.org/" >&2
  if command -v open >/dev/null 2>&1; then open https://nodejs.org/ >/dev/null 2>&1 || true; fi
  fail "未找到 Node.js。安装后重新运行本命令。"
fi

if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)' >/dev/null 2>&1; then
  fail "Node.js 版本过低，需要 22.19 或更高版本（当前：$(node --version)）。"
fi

if [ "${INSTALL_HOST}" = "cli" ] && ! command -v npm >/dev/null 2>&1; then
  fail "未找到 npm，请重新安装 Node.js。"
fi

# UI updates start in a fresh process that may not inherit the install-time PATH.
# Only CLI may use Tavern-managed tools; Desktop must keep its host PATH.
if [ "${INSTALL_HOST}" = "cli" ]; then
  PATH=${RUNTIME_BIN}:${PATH}
  export PATH
fi

if [ "${INSTALL_HOST}" = "cli" ]; then
  DSH_TAVERN_BIN_DIR=${COMMAND_BIN}
  export DSH_TAVERN_BIN_DIR
fi

command -v tar >/dev/null 2>&1 || fail "未找到 tar。"

# Standalone bootstrap must log before the repository has been downloaded.
UPDATE_LOG_ROOT=${DSH_TAVERN_UPDATE_LOG_ROOT:-${DSH_ROOT}/profile-data/tavern/data}
DSH_TAVERN_UPDATE_ATTEMPT=${DSH_TAVERN_UPDATE_ATTEMPT:-install-$$-$(date +%s)}
export DSH_TAVERN_UPDATE_ATTEMPT
cat > "${TEMP_DIR}/update-log.cjs" <<'UPDATE_LOG_JS'
const fs=require('node:fs'),path=require('node:path');
try {
 const [root,event,step,exitCode,startedAt,file]=process.argv.slice(2);
 const clean=value=>String(value||'').replace(/https?:\/\/[^\s<>"')]+/g,raw=>{try{const u=new URL(raw);return u.origin+u.pathname}catch{return '[URL]'}}).replace(/Bearer\s+[^\s,;]+/gi,'Bearer [redacted]').replace(/((?:authorization|token|password|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi,'$1[redacted]');
 let output=file&&fs.existsSync(file)?clean(fs.readFileSync(file,'utf8')):'';
 const outputCharacters=output.length;
 if(output.length>6000)output=output.slice(0,3000)+'\n[中间输出省略]\n'+output.slice(-3000);
 const record={at:new Date().toISOString(),pid:process.ppid,attemptId:process.env.DSH_TAVERN_UPDATE_ATTEMPT,event,step,exitCode:exitCode===''?undefined:Number(exitCode),durationMs:startedAt?Date.now()-Number(startedAt):undefined,output,outputCharacters};
 fs.mkdirSync(root,{recursive:true});const target=path.join(root,'update-diagnostics.jsonl');
 try{if(fs.statSync(target).size>1048576){try{fs.unlinkSync(target+'.1')}catch{}fs.renameSync(target,target+'.1')}}catch{}
 fs.appendFileSync(target,JSON.stringify(record)+'\n');
}catch{}
UPDATE_LOG_JS
update_log() {
  node "${TEMP_DIR}/update-log.cjs" "$UPDATE_LOG_ROOT" "$@" >/dev/null 2>&1 || true
}
run_git() {
  git_step=$1
  shift
  git_started=$(node -p 'Date.now()')
  update_log installer.stage.started "$git_step" '' '' ''
  if git "$@" >"${TEMP_DIR}/git.stdout" 2>"${TEMP_DIR}/git.stderr"; then git_code=0; else git_code=$?; fi
  cat "${TEMP_DIR}/git.stdout"
  cat "${TEMP_DIR}/git.stderr" >&2
  cat "${TEMP_DIR}/git.stdout" "${TEMP_DIR}/git.stderr" >"${TEMP_DIR}/git.output"
  if [ "$git_code" -eq 0 ]; then git_event=installer.stage.succeeded; else git_event=installer.stage.failed; fi
  update_log "$git_event" "$git_step" "$git_code" "$git_started" "${TEMP_DIR}/git.output"
  if [ "$git_code" -ne 0 ]; then echo "Git 步骤失败：${git_step}（退出码 ${git_code}），正在尝试备用源。" >&2; fi
  return "$git_code"
}
update_log installer.started bootstrap '' '' ''
echo "更新诊断日志：${UPDATE_LOG_ROOT}/update-diagnostics.jsonl"

echo "正在增量同步 DSH Tavern……"
USED_GIT=0
USED_CDN=0
if command -v git >/dev/null 2>&1; then
  echo "正在通过 Git 增量同步（不下载文档与图片）……"
  mkdir -p "$(dirname -- "${SOURCE_CACHE}")"
  if { [ -f "${SOURCE_CACHE}/HEAD" ] || run_git git.clone clone --bare --filter=blob:none --depth 1 --single-branch --branch main "${REPOSITORY_URL}" "${SOURCE_CACHE}"; } \
    && run_git git.remote --git-dir="${SOURCE_CACHE}" remote set-url origin "${REPOSITORY_URL}" \
    && run_git git.fetch --git-dir="${SOURCE_CACHE}" fetch --depth 1 origin main \
    && TARGET_COMMIT=$(run_git git.revision --git-dir="${SOURCE_CACHE}" rev-parse FETCH_HEAD) \
    && run_git git.archive -c core.autocrlf=false -c core.eol=lf --git-dir="${SOURCE_CACHE}" archive --format=tar --output="${TEMP_DIR}/app.tar" FETCH_HEAD -- ${RUNTIME_PATHS}; then
    USED_GIT=1
  else
    echo "Git 增量更新失败，正在尝试 jsDelivr 备用源。" >&2
  fi
else
  update_log installer.stage.failed git.unavailable 127 '' ''
  echo "未找到 Git，正在尝试备用源。" >&2
fi

if [ "${USED_GIT}" -eq 0 ]; then
  echo "正在通过 jsDelivr 备用源下载运行代码……"
  update_log installer.stage.started source.jsdelivr '' '' ''
  mkdir -p "${TEMP_DIR}/cdn-source"
  # Shared download module: bin/download.cjs, embedded by bin/build-installer-scripts.mjs.
  cat >"${TEMP_DIR}/download.cjs" <<'DSH_DOWNLOAD_MODULE'
'use strict'
// Shared network downloads for the installers and Windows Desktop package management.
// install.ps1 and install.sh embed this file verbatim because they run before any
// code is downloaded: edit it here, then run `node bin/build-installer-scripts.mjs`.
// Keep it dependency-free CommonJS for Node >= 22.19 (Desktop runs it under Electron).
//
// Timeouts follow one rule: a transfer fails when no bytes arrive for `stallMs`
// (slow but moving downloads keep going); `deadlineMs` is only a generous upper bound.
const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { setTimeout: delay } = require('node:timers/promises')

const RUNTIME_PATH = /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|cordis\.patch\.yml|install\.ps1|install\.sh|bin\/|config\/|presets\/|patches\/|tavern-plugin\/)/
const EXCLUDED_PART = new Set(['.', '..', 'docs', 'tests', '__tests__', 'testsets'])

class DownloadError extends Error {
  constructor(message, { reason, attempts = [], cause } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'DownloadError'
    this.reason = reason
    this.attempts = attempts
  }
}

function failure(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra })
}

const NETWORK_REASONS = [
  [/^(ENOTFOUND|EAI_AGAIN)$/, '域名解析失败'],
  [/^ECONNREFUSED$/, '连接被拒绝'],
  [/^(ECONNRESET|EPIPE|UND_ERR_SOCKET|UND_ERR_CLOSED)$/, '连接被中断'],
  [/^(ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT)$/, '连接超时'],
  [/^(ENETUNREACH|EHOSTUNREACH)$/, '网络不可达'],
  [/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|ERR_SSL/, 'TLS 证书校验失败（可能被代理或安全软件拦截）'],
]

// One short Chinese reason per failure; the underlying error stays in `cause`.
function describeFailure(error) {
  if (!error) return '未知错误'
  if (error.code === 'STALLED' || error.code === 'DEADLINE' || error.code === 'HTTP' || error.code === 'CHECKSUM') return error.message
  if (error.name === 'TimeoutError') return '请求超时'
  if (error.name === 'AbortError') return '请求被中止'
  let current = error
  for (let depth = 0; current && depth < 4; depth++, current = current.cause) {
    const code = String(current.code || '')
    for (const [pattern, reason] of NETWORK_REASONS) if (pattern.test(code)) return `${reason}（${code}）`
  }
  return String(error.cause?.code || error.cause?.message || error.message || error)
}

const duration = ms => ms >= 60000 && ms % 60000 === 0 ? `${ms / 60000} 分钟` : `${Number((ms / 1000).toFixed(1))} 秒`

function hostOf(url) {
  try { return new URL(url).hostname } catch { return String(url) }
}

// Fetch one URL into memory, aborting when no data arrives for `stallMs`.
async function fetchBytes(url, { stallMs = 30000, signal, headers, onData, fetch: request = fetch } = {}) {
  const controller = new AbortController()
  let stalled = false, timer
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => { stalled = true; controller.abort() }, stallMs) }
  const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
  arm()
  try {
    const response = await request(url, { signal: combined, headers, redirect: 'follow' })
    if (!response.ok) {
      try { await response.body?.cancel() } catch {}
      throw failure('HTTP', `HTTP ${response.status}`, { status: response.status })
    }
    const total = Number(response.headers?.get?.('content-length')) || 0
    const chunks = []
    let received = 0
    if (response.body) for await (const chunk of response.body) {
      arm()
      const bytes = Buffer.from(chunk)
      chunks.push(bytes); received += bytes.length
      onData?.(received, total)
    }
    return Buffer.concat(chunks)
  } catch (error) {
    if (stalled) throw failure('STALLED', `${duration(stallMs)}没有收到数据`, { cause: error })
    throw error
  } finally { clearTimeout(timer) }
}

// Try `urls` in turn (cycling) until one returns bytes matching `sha256`/`size`.
async function download(urls, options = {}) {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean)
  if (!list.length) throw new TypeError('download() needs at least one URL')
  const { sha256, size, label = path.posix.basename(new URL(list[0]).pathname) || list[0], stallMs = 30000, deadlineMs,
    attempts = Math.max(2, list.length), retryDelayMs = 1000, signal, headers, onProgress, onAttempt, onRetry } = options
  const deadline = deadlineMs ? AbortSignal.timeout(deadlineMs) : undefined
  const limit = [signal, deadline].filter(Boolean)
  const combined = limit.length > 1 ? AbortSignal.any(limit) : limit[0]
  const records = []
  let last
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const url = list[(attempt - 1) % list.length]
    onAttempt?.({ url, host: hostOf(url), attempt, attempts })
    try {
      const bytes = await fetchBytes(url, { stallMs, signal: combined, headers, fetch: options.fetch,
        onData: (received, total) => onProgress?.({ url, host: hostOf(url), received, total, attempt, attempts }) })
      if (size !== undefined && bytes.length !== size) throw failure('CHECKSUM', `文件大小不符（应为 ${size} 字节，实际 ${bytes.length}）`)
      if (sha256 && createHash('sha256').update(bytes).digest('hex') !== String(sha256).toLowerCase()) throw failure('CHECKSUM', 'SHA-256 校验不符')
      return { bytes, url }
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error
      if (deadline?.aborted) {
        last = failure('DEADLINE', `超过总时长上限 ${duration(deadlineMs)}`, { cause: error })
        records.push({ url, reason: last.message })
        break
      }
      last = error
      const reason = describeFailure(error)
      records.push({ url, reason })
      const willRetry = attempt < attempts
      onRetry?.({ url, host: hostOf(url), attempt, attempts, reason, willRetry, error })
      if (willRetry) {
        try { await delay(retryDelayMs * attempt, undefined, combined ? { signal: combined } : undefined) }
        catch { if (signal?.aborted) throw signal.reason; break }
      }
    }
  }
  const reason = describeFailure(last)
  throw new DownloadError(`${label} 下载失败（已尝试 ${records.length} 次）：${reason}`, { reason, attempts: records, cause: last })
}

// Download to `destination`; only a verified, complete file is ever published there.
async function downloadFile(urls, destination, options = {}) {
  const result = await download(urls, options)
  await fs.mkdir(path.dirname(destination), { recursive: true })
  const partial = `${destination}.download-${process.pid}-${Date.now()}`
  try {
    await fs.writeFile(partial, result.bytes)
    await fs.rename(partial, destination)
  } finally { await fs.rm(partial, { force: true }) }
  return result
}

function runtimeFiles(metadata) {
  if (!/^[0-9a-f]{40}$/i.test(String(metadata?.revision || ''))) throw new Error('运行清单缺少有效提交号')
  const files = (Array.isArray(metadata.files) ? metadata.files : [])
    .map(file => ({ ...file, path: String(file?.path || '') }))
    .filter(file => RUNTIME_PATH.test(file.path) && !file.path.split('/').some(part => EXCLUDED_PART.has(part)))
  for (const file of files) {
    if (file.path.includes('\\') || file.path.includes(':') || file.path.split('/').some(part => !part) || !/^[0-9a-f]{64}$/i.test(String(file.sha256 || ''))) {
      throw new Error(`运行清单包含无效文件：${file.path}`)
    }
  }
  if (!files.length) throw new Error('运行清单没有可下载的运行文件')
  return files
}

// Download the runtime files listed by a jsDelivr manifest into `destination`.
// Files whose bytes already match in `installed` are reused instead of downloaded.
async function downloadRuntime({ metadataUrl, rootUrl, destination, installed, concurrency = 6, stallMs = 30000,
  budgetMs = 300000, attempts = 2, status = () => {}, fetch: request } = {}) {
  const source = hostOf(rootUrl)
  const { bytes } = await download([metadataUrl], { label: '运行清单', stallMs: Math.min(stallMs, 15000), attempts, fetch: request })
  const metadata = JSON.parse(bytes.toString('utf8'))
  const files = runtimeFiles(metadata)
  const controller = new AbortController()
  const budget = AbortSignal.timeout(budgetMs)
  const signal = AbortSignal.any([controller.signal, budget])
  let next = 0, done = 0, reused = 0, received = 0
  const report = () => status(`下载代码（${source}）：${done}/${files.length} 文件，复用 ${reused}，已下载 ${(received / 1048576).toFixed(1)} MB`)
  report()
  const worker = async () => {
    while (next < files.length) {
      signal.throwIfAborted()
      const file = files[next++]
      const parts = file.path.split('/')
      let content
      if (installed) {
        try {
          const local = await fs.readFile(path.join(installed, ...parts))
          if (createHash('sha256').update(local).digest('hex') === file.sha256.toLowerCase()) { content = local; reused++ }
        } catch {}
      }
      if (!content) {
        const url = `${rootUrl}@${metadata.revision}/${parts.map(encodeURIComponent).join('/')}`
        content = (await download([url], { label: file.path, sha256: file.sha256, stallMs, attempts, signal, fetch: request,
          onRetry: ({ attempt, attempts: total, reason, willRetry }) => status(`下载失败（${source}）：${file.path}，${reason}；尝试 ${attempt}/${total}${willRetry ? '，正在重试' : '，将切换备用方案'}。`),
        })).bytes
        received += content.length
      }
      signal.throwIfAborted()
      const target = path.join(destination, ...parts)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, content)
      done++
      report()
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker))
  } catch (error) {
    controller.abort()
    if (budget.aborted) throw new Error(`备用源下载超过 ${duration(budgetMs)}，将切换备用方案`, { cause: error })
    throw error
  }
  await fs.writeFile(path.join(destination, 'dsh-tavern-runtime.json'), `${JSON.stringify(metadata, null, 2)}\n`)
  return metadata
}

const PROXY_KEYS = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY']
const INTERNET_SETTINGS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
const envValue = (env, name) => Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1]

function readInternetSettings() {
  const output = require('node:child_process').execFileSync('reg', ['query', INTERNET_SETTINGS], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
  const values = {}
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s+(\S+)\s+REG_\w+\s+(.*?)\s*$/.exec(line)
    if (match) values[match[1]] = match[2]
  }
  return values
}

function proxyUrl(value) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`
}

// Windows "system proxy" (WinINET) is invisible to Node fetch, curl, git and pnpm,
// which only read HTTP(S)_PROXY. Translate it into those variables when none is set.
// Returns the variables to add plus a display summary without credentials.
function proxyEnvironment(env = process.env, { platform = process.platform, readSettings = readInternetSettings } = {}) {
  const added = {}
  const useEnvProxy = () => { if (envValue(env, 'NODE_USE_ENV_PROXY') === undefined) added.NODE_USE_ENV_PROXY = '1' }
  if (PROXY_KEYS.some(key => envValue(env, key))) {
    useEnvProxy()
    return { added, source: 'environment' }
  }
  if (platform !== 'win32') return { added, source: null }
  let settings
  try { settings = readSettings() } catch { return { added, source: null } }
  if (Number(settings.ProxyEnable) === 1 && settings.ProxyServer) {
    const entries = {}
    for (const part of settings.ProxyServer.split(';').map(item => item.trim()).filter(Boolean)) {
      const [scheme, address] = part.includes('=') ? part.split('=', 2) : ['*', part]
      entries[scheme.toLowerCase()] = address
    }
    const http = entries.http || entries['*']
    const https = entries.https || http
    if (http || https) {
      if (http) added.HTTP_PROXY = proxyUrl(http)
      if (https) added.HTTPS_PROXY = proxyUrl(https)
      if (envValue(env, 'NO_PROXY') === undefined) {
        const bypass = String(settings.ProxyOverride || '').split(';').map(item => item.trim())
          .filter(item => item && item !== '<local>' && !item.slice(1).includes('*'))
          .map(item => item.replace(/^\*/, ''))
        added.NO_PROXY = [...new Set(['localhost', '127.0.0.1', '::1', ...bypass])].join(',')
      }
      useEnvProxy()
      return { added, source: 'system', summary: new URL(added.HTTPS_PROXY || added.HTTP_PROXY).host }
    }
    if (entries.socks) return { added, source: 'unsupported', summary: '系统代理只提供 SOCKS，安装程序无法使用；请在代理软件中开启 HTTP 代理或 TUN 模式' }
  }
  if (settings.AutoConfigURL) return { added, source: 'pac', summary: '系统代理使用 PAC 自动配置脚本，安装程序无法读取；如下载失败，请在代理软件中开启 TUN 模式或设置 HTTPS_PROXY' }
  return { added, source: null }
}

// Apply proxyEnvironment() to `env` and, when env is this process's environment,
// to this process's own fetch (Node >= 24.5 can switch the global proxy at runtime).
function applyProxyEnvironment(env = process.env, options) {
  const result = proxyEnvironment(env, options)
  Object.assign(env, result.added)
  if (result.added.HTTPS_PROXY || result.added.HTTP_PROXY) {
    try { require('node:http').setGlobalProxyFromEnv?.(env) } catch {}
  }
  return result
}

function parseOptions(args) {
  const options = {}, rest = []
  for (let index = 0; index < args.length; index++) {
    const match = /^--([a-z0-9-]+)$/.exec(args[index])
    if (match) options[match[1]] = args[++index]
    else rest.push(args[index])
  }
  return { options, rest }
}

const seconds = (value, fallback) => (value === undefined ? fallback : Number(value) * 1000)

// CLI used by the installer scripts:
//   node download.cjs file <destination> [--sha256 H] [--stall S] [--deadline S] [--attempts N] <url>...
//   node download.cjs runtime <metadata-url> <root-url> <destination> [<installed-dir>] [--stall S] [--budget S]
//   node download.cjs proxy-env   prints KEY=VALUE lines to add (Windows system proxy)
async function main(argv) {
  const [command, ...args] = argv
  const { options, rest } = parseOptions(args)
  const status = message => console.log(`DSH_STATUS ${message}`)
  if (command === 'file') {
    const [destination, ...urls] = rest
    if (!destination || !urls.length) throw new Error('用法：download.cjs file <目标文件> <URL>...')
    await downloadFile(urls, destination, { sha256: options.sha256, stallMs: seconds(options.stall, 30000),
      deadlineMs: seconds(options.deadline, undefined), attempts: options.attempts ? Number(options.attempts) : undefined })
    return
  }
  if (command === 'runtime') {
    const [metadataUrl, rootUrl, destination, installed] = rest
    if (!metadataUrl || !rootUrl || !destination) throw new Error('用法：download.cjs runtime <清单 URL> <CDN 根 URL> <目标目录> [已安装目录]')
    const metadata = await downloadRuntime({ metadataUrl, rootUrl: rootUrl.replace(/\/+$/, ''), destination, installed,
      stallMs: seconds(options.stall, 30000), budgetMs: seconds(options.budget, 300000), status })
    status(`下载代码完成：${metadata.revision.slice(0, 12)}`)
    return
  }
  if (command === 'proxy-env') {
    const { added, summary } = proxyEnvironment(process.env)
    for (const [key, value] of Object.entries(added)) console.log(`${key}=${value}`)
    if (summary) status(added.HTTPS_PROXY || added.HTTP_PROXY ? `使用系统代理：${summary}` : summary)
    return
  }
  throw new Error(`未知命令：${command || '(空)'}`)
}

module.exports = { download, downloadFile, downloadRuntime, describeFailure, runtimeFiles, proxyEnvironment, applyProxyEnvironment, DownloadError, RUNTIME_PATH }

if (require.main === module) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1 })
}
DSH_DOWNLOAD_MODULE
  if node "${TEMP_DIR}/download.cjs" runtime "${CDN_METADATA_URL}" "${CDN_ROOT_URL}" "${TEMP_DIR}/cdn-source" "${APP_DIR}" 2>"${TEMP_DIR}/cdn.stderr"
  then
    update_log installer.stage.succeeded source.jsdelivr 0 '' ''
    USED_CDN=1
    TARGET_COMMIT=$(node -p 'require(process.argv[1]).revision' "${TEMP_DIR}/cdn-source/dsh-tavern-runtime.json")
  else
    update_log installer.stage.failed source.jsdelivr 1 '' "${TEMP_DIR}/cdn.stderr"
    cat "${TEMP_DIR}/cdn.stderr" >&2
    echo "jsDelivr 备用源不可用，将回退到精简运行压缩包。" >&2
  fi
fi

if [ "${USED_GIT}" -eq 0 ] && [ "${USED_CDN}" -eq 0 ]; then
  command -v curl >/dev/null 2>&1 || fail "Git 不可用且未找到 curl，无法下载精简运行压缩包。"
  echo "正在下载精简运行压缩包……"
  if [ -z "${TARGET_COMMIT}" ]; then
    TARGET_COMMIT=$(curl -fsSL --connect-timeout 10 "${COMMIT_URL}" | sed -n 's/^[[:space:]]*"sha":[[:space:]]*"\([0-9a-fA-F]*\)".*/\1/p' | head -n 1 || true)
  fi
  # Fail only after 30 s without data; --max-time is a generous upper bound.
  curl -fL --retry 3 --connect-timeout 15 --speed-limit 1 --speed-time 30 --max-time 900 "${ARCHIVE_URL}" -o "${TEMP_DIR}/app.tar.gz"
fi
mkdir -p "${TEMP_DIR}/extract"
if [ "${USED_CDN}" -eq 1 ]; then
  SOURCE_DIR=${TEMP_DIR}/cdn-source
elif [ "${USED_GIT}" -eq 1 ]; then
  tar -xf "${TEMP_DIR}/app.tar" -C "${TEMP_DIR}/extract"
  SOURCE_DIR=${TEMP_DIR}/extract
else
  tar -xzf "${TEMP_DIR}/app.tar.gz" -C "${TEMP_DIR}/extract" --exclude='*/docs' --exclude='*/docs/*'
  SOURCE_DIR=$(find "${TEMP_DIR}/extract" -mindepth 1 -maxdepth 1 -type d | head -n 1)
fi
[ -n "${SOURCE_DIR}" ] || fail "下载内容不完整。"
[ -f "${SOURCE_DIR}/package.json" ] || fail "下载内容不完整。"

# Read the downloaded release's version, not the bootstrap script's or npm's latest.
ADAPTED_DSH_VERSION=$(node "${SOURCE_DIR}/bin/dsh-compatibility.mjs" --version)
node "${SOURCE_DIR}/bin/dsh-compatibility.mjs" --notice "${INSTALL_HOST}"
if [ "${INSTALL_HOST}" = "cli" ]; then
  set --
  INSTALLED_PNPM_VERSION=$(pnpm --version 2>/dev/null || true)
  if [ "${INSTALLED_PNPM_VERSION}" != "${PNPM_VERSION}" ]; then
    set -- "$@" "pnpm@${PNPM_VERSION}"
  fi
  if [ "$#" -gt 0 ]; then
    echo "正在安装缺失依赖：$*……"
    mkdir -p "${RUNTIME_ROOT}"
    npm install --global --prefix "${RUNTIME_ROOT}" "$@"
  fi
fi
command -v pnpm >/dev/null 2>&1 || fail "未找到 pnpm。Desktop 版请从 DSH Desktop 托盘打开 DSH Terminal 后运行本命令。"
[ "${INSTALL_HOST}" = "cli" ] || command -v dsh >/dev/null 2>&1 || fail "未找到 DSH。Desktop 版请从 DSH Desktop 托盘打开 DSH Terminal 后运行本命令。"

# Validate the downloaded release against the host before replacing any app files.
if [ "${INSTALL_HOST}" != "cli" ]; then
  CURRENT_DSH_VERSION=$(dsh --version) || fail "无法读取宿主 DSH 版本。"
  node "${SOURCE_DIR}/bin/dsh-compatibility.mjs" --check "${INSTALL_HOST}" "${CURRENT_DSH_VERSION}"
fi

if [ "${INSTALL_HOST}" = "cli" ] && [ -f "${APP_DIR}/bin/dsh-tavern.mjs" ]; then
  DSH_HOME=${DSH_ROOT} node "${APP_DIR}/bin/dsh-tavern.mjs" stop >/dev/null 2>&1 || true
fi

mkdir -p "${APP_DIR}"
# 覆盖程序文件但不删除旧目录，因此未被发布包跟踪的 data/ 用户数据会保留。
# 新版本自带的清理脚本只删除上次安装放入、而新版本已不再包含的文件；失败不影响安装。
if [ -f "${SOURCE_DIR}/bin/prune-installed-files.mjs" ]; then
  node "${SOURCE_DIR}/bin/prune-installed-files.mjs" "${SOURCE_DIR}" "${APP_DIR}" || echo "警告：旧版本遗留文件清理失败，继续安装。" >&2
fi
cp -R "${SOURCE_DIR}/." "${APP_DIR}/"
if [ "${USED_CDN}" -eq 1 ]; then rm -f -- "${APP_DIR}/.dsh-tavern-release.json"; fi
case ${TARGET_COMMIT} in
  *[!0-9a-fA-F]*|'') ;;
  ????????????????????????????????????????)
    printf '{"commit":"%s","installedAt":"%s"}\n' "${TARGET_COMMIT}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"${APP_DIR}/.dsh-tavern-release.json"
    ;;
esac

echo "正在安装程序依赖……"
pnpm --dir "${APP_DIR}" install --frozen-lockfile

echo "正在配置 Tavern……"
DSH_HOME=${DSH_ROOT} node "${APP_DIR}/bin/dsh-tavern.mjs" install --host "${INSTALL_HOST}"

if [ "${INSTALL_HOST}" = "desktop" ]; then
  echo "DSH Tavern Desktop 版安装完成。"
  echo "请重启 DSH Desktop，再从托盘的 Profile 菜单切换到 tavern。"
else
  DSH_HOME=${DSH_ROOT} node "${APP_DIR}/bin/dsh-tavern.mjs" start
  case ${SHELL:-} in
    */zsh) SHELL_PROFILE=${HOME}/.zprofile ;;
    *) SHELL_PROFILE=${HOME}/.profile ;;
  esac
  PATH_LINE='export PATH="$HOME/.local/bin:$PATH"'
  if [ ! -f "${SHELL_PROFILE}" ] || ! grep -F "${PATH_LINE}" "${SHELL_PROFILE}" >/dev/null 2>&1; then
    printf '\n# DSH Tavern\n%s\n' "${PATH_LINE}" >>"${SHELL_PROFILE}"
  fi
  echo "DSH Tavern 安装完成。请使用上方完整访问地址，或运行 dsh-tavern open 打开网页。"
  echo "以后可以使用：dsh-tavern {start|open|stop|restart|status|update}（新终端生效）"
fi

INSTALL_COMPLETED=1
