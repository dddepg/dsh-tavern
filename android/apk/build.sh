#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
WORK="${TAVERN_APK_WORK:-${ROOT}/output/android-apk}"
VERSION=v0.1.5-rc2
COMMIT=dca04aed7c1a1468827a953bfd6295fc3ca44170
mkdir -p "$WORK"
if [ ! -d "$WORK/dsha/.git" ]; then
  git clone --depth 1 --branch "$VERSION" https://github.com/DSH-APP/DSHA.git "$WORK/dsha"
fi
[ "$(git -C "$WORK/dsha" rev-parse HEAD)" = "$COMMIT" ] || { echo 'DSHA 版本不匹配' >&2; exit 1; }
APK="$WORK/dsha-0.1.5-rc2.apk"
if [ ! -f "$APK" ]; then
  curl -fL --retry 2 "https://github.com/DSH-APP/DSHA/releases/download/${VERSION}/dsha-0.1.5-rc2.apk" -o "$APK.part"
  mv "$APK.part" "$APK"
fi
: "${JAVA_HOME:?请设置 JDK 17 或更新版本的 JAVA_HOME}"
: "${ANDROID_HOME:?请设置 Android SDK 的 ANDROID_HOME}"
BUILD="$(mktemp -d "${WORK}/build.XXXXXX")"
rmdir "$BUILD"
npm ci --prefix "$WORK/dsha/tools/web-compat" --ignore-scripts --no-audit --no-fund
python3 "$ROOT/android/apk/prepare.py" --source "$WORK/dsha" --apk "$APK" --output "$BUILD"
node "$ROOT/android/apk/build-web-compat.mjs" "$WORK/dsha" "$BUILD/app/src/tavern/assets"
cd "$BUILD"
MODE="${TAVERN_APK_MODE:-Debug}"
case "$MODE" in
  Debug) ;;
  Release) : "${DSHA_KEYSTORE:?发布包必须指定独立的酒馆签名密钥 DSHA_KEYSTORE}" ;;
  *) echo 'TAVERN_APK_MODE 只能为 Debug 或 Release' >&2; exit 1 ;;
esac
./gradlew ":app:assembleStandard${MODE}" :app:testStandardDebugUnitTest --console=plain
python3 - "$BUILD" "$WORK" "$MODE" <<'PY'
import hashlib, pathlib, shutil, sys
build, work, mode = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3].lower()
source = build / f'app/build/outputs/apk/standard/{mode}/app-standard-{mode}.apk'
target = work / f'dsh-tavern-android-{mode}.apk'
shutil.copyfile(source, target)
target.with_suffix('.apk.sha256').write_text(hashlib.sha256(target.read_bytes()).hexdigest() + '  ' + target.name + '\n')
print(target)
PY
