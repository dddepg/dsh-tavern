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
RUNTIME_PATHS='package.json pnpm-lock.yaml pnpm-workspace.yaml cordis.patch.yml install.ps1 install.sh bin config presets tavern-plugin patches'
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
  if CDN_METADATA_URL="${CDN_METADATA_URL}" CDN_ROOT_URL="${CDN_ROOT_URL}" CDN_SOURCE="${TEMP_DIR}/cdn-source" node 2>"${TEMP_DIR}/cdn.stderr" <<'NODE'
const { createHash } = require('node:crypto')
const { mkdir, writeFile } = require('node:fs/promises')
const path = require('node:path')
const allowed = /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|cordis\.patch\.yml|install\.ps1|install\.sh|bin\/|config\/|presets\/|tavern-plugin\/|patches\/)/
async function get(url, timeout = 30000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout) })
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return response
}
;(async () => {
  const metadata = await (await get(process.env.CDN_METADATA_URL, 15000)).json()
  if (!/^[0-9a-f]{40}$/i.test(String(metadata.revision || ''))) throw new Error('jsDelivr 运行清单缺少有效提交号')
  const files = (metadata.files || []).map((file) => ({ ...file, path: String(file.path || '').replace(/^\/+/, '') }))
    .filter((file) => allowed.test(file.path) && !file.path.split('/').some(part => ['..', 'docs', 'tests', '__tests__', 'testsets'].includes(part)) && /^[0-9a-f]{64}$/i.test(String(file.sha256 || '')))
  if (files.length === 0) throw new Error('jsDelivr 未返回运行文件清单')
  for (const file of files) {
    const bytes = Buffer.from(await (await get(`${process.env.CDN_ROOT_URL}@${metadata.revision}/${file.path}`)).arrayBuffer())
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== String(file.sha256).toLowerCase()) throw new Error(`jsDelivr 文件校验失败：${file.path}`)
    const target = path.join(process.env.CDN_SOURCE, ...file.path.split('/'))
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, bytes)
  }
  await writeFile(path.join(process.env.CDN_SOURCE, 'dsh-tavern-runtime.json'), `${JSON.stringify(metadata, null, 2)}\n`)
  await writeFile(path.join(process.env.CDN_SOURCE, '.revision'), metadata.revision)
})().catch((error) => { console.error(error.message); process.exit(1) })
NODE
  then
    update_log installer.stage.succeeded source.jsdelivr 0 '' ''
    USED_CDN=1
    TARGET_COMMIT=$(cat "${TEMP_DIR}/cdn-source/.revision")
    rm -f -- "${TEMP_DIR}/cdn-source/.revision"
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
  curl -fL --retry 3 --connect-timeout 15 "${ARCHIVE_URL}" -o "${TEMP_DIR}/app.tar.gz"
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
