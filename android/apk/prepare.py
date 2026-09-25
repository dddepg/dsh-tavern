#!/usr/bin/env python3
"""从锁定 DSHA 源码及官方 APK 的已验证资产生成独立酒馆构建目录。"""
import argparse
import hashlib
from pathlib import Path
import shutil
import subprocess
import zipfile

COMMIT = 'dca04aed7c1a1468827a953bfd6295fc3ca44170'
APK_SHA256 = '85cb7c7213681ced654788f940b16313b3b5e2b662add87432ede95446a30658'
HERE = Path(__file__).resolve().parent


def replace(file, before, after):
    text = file.read_text()
    if text.count(before) != 1:
        raise ValueError(f'上游补丁锚点不唯一：{file}: {before[:80]}')
    file.write_text(text.replace(before, after))


def prepare(source, apk, destination):
    actual = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    if actual != COMMIT:
        raise ValueError(f'DSHA 源码版本不匹配：{actual}')
    if subprocess.check_output(['git', '-C', str(source), 'status', '--porcelain'], text=True).strip():
        raise ValueError('DSHA 源码有本地修改，请使用干净的锁定提交')
    if hashlib.sha256(apk.read_bytes()).hexdigest() != APK_SHA256:
        raise ValueError('官方 APK 摘要不匹配')
    if destination.exists():
        raise ValueError('输出目录已存在，请选择新的目录，避免覆盖本地修改')
    shutil.copytree(source, destination, ignore=shutil.ignore_patterns('.git', '.gradle', 'build', 'local.properties'))
    app = destination / 'app'
    assets = app / 'src/tavern/assets'
    assets.mkdir(parents=True)
    # 官方发布已经执行过标准资产构建；逐字节复用通过整体摘要验证的产物。
    with zipfile.ZipFile(apk) as archive:
        for name in archive.namelist():
            if name.startswith('lib/arm64-v8a/') and name.endswith('.so'):
                relative = Path(name).relative_to('lib')
                if '..' in relative.parts:
                    raise ValueError('非法原生库路径')
                target = app / 'src/main/jniLibs' / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.read(name))
            if not name.startswith('assets/') or name.endswith('/') or name.startswith('assets/dexopt/'):
                continue
            relative = Path(name).relative_to('assets')
            if '..' in relative.parts:
                raise ValueError('非法资产路径')
            target = assets / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.read(name))
    setup = (HERE.parent / 'setup.sh').read_text()
    setup += '\n# 独立 APK 由原生生命周期持有 tavern 主进程，结束安装器的临时服务。\n'
    setup += 'DSH_TAVERN_PORT=3088 DSH_TAVERN_RUNTIME_HOST=android node /root/.dsh/apps/dsh-tavern/bin/dsh-tavern.mjs stop\n'
    (assets / 'tavern-apk-setup.sh').write_text(setup)
    java = app / 'src/main/java/com/deepseekharness/app'
    shutil.copyfile(HERE / 'TavernBootstrap.java', java / 'core/TavernBootstrap.java')
    tests = app / 'src/test/java/com/deepseekharness/app/util'
    tests.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(HERE / 'TavernWebProcessTest.java', tests / 'TavernWebProcessTest.java')
    gradle = app / 'build.gradle'
    replace(gradle, 'applicationId "com.dsh.client"', 'applicationId "io.github.flizzywine.dshtavern"')
    replace(gradle, 'main.assets.setSrcDirs([layout.buildDirectory.dir("generated/standardAssets")])', 'main.assets.setSrcDirs(["src/tavern/assets"])')
    replace(gradle, 'tasks.named("preBuild").configure { dependsOn(prepareStandardAssets) }', '// 使用经过固定摘要验证的官方 APK 资产。')
    for resource in (app / 'src/main/res').glob('values*/strings.xml'):
        import re
        resource.write_text(re.sub(r'(<string name="app_name"[^>]*>).*?(</string>)', r'\1DSH Tavern\2', resource.read_text()))
    for layout in (app / 'src/main/res').glob('layout*/welcome_page1.xml'):
        layout.write_text(layout.read_text().replace('android:text="DSHA"', 'android:text="DSH Tavern"'))
    welcome = app / 'src/main/res/layout/welcome_page1.xml'
    replace(welcome, 'android:text="@string/ui_m0035"', 'android:text="@string/tavern_first_install"')
    for language, message in {
        'values': '内置 DSHA 运行环境。首次打开将联网下载最新版酒馆并安装依赖，请保持网络连接。无需输入安装命令。',
        'values-en': 'Includes the DSHA runtime. First launch downloads the latest Tavern and installs its dependencies. Keep your internet connection active. No installation commands required.',
    }.items():
        (app / f'src/main/res/{language}/tavern_strings.xml').write_text(
            '<?xml version="1.0" encoding="utf-8"?><resources><string name="tavern_first_install">'
            + message + '</string></resources>\n')
    controller = java / 'core/HarnessController.java'
    replace(controller, '            String startupProfile = "web";', '''            if (!safeMode) {
                TavernBootstrap.ensure(ctx, boot, () -> !lifecycle.isCurrent(generation), message -> {
                    if (message.startsWith("首次安装：")) setWebStage(generation, "下载并安装最新版酒馆");
                    reportStatus(generation, onStatus, message);
                });
            }
            String startupProfile = "tavern";''')
    replace(controller, 'export DSH_HOME=/root/.dsh && ',
            'export DSH_HOME=/root/.dsh DSH_TAVERN_RUNTIME_HOST=android DSH_TAVERN_ANDROID_STANDALONE=1 pnpm_config_update_notifier=false && ')
    replace(java / 'util/WebProcSel.java',
            'args[index + 1].matches("dsha-recovery-[0-9a-f]{16}")',
            '(args[index + 1].equals("tavern") || args[index + 1].matches("dsha-recovery-[0-9a-f]{16}"))')
    launch = java / 'ui/LaunchFragment.java'
    replace(java / 'ui/WebPreviewActivity.java',
            '            WebView view = new WebView(new android.content.MutableContextWrapper(this));',
            '''            if (com.deepseekharness.app.BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true);
            WebView view = new WebView(new android.content.MutableContextWrapper(this));''')
    replace(launch, '            String localUrl = webEntryUrl();', '''            if (ready && !trace.safe && isResumed() && !enteringWeb) {
                android.content.SharedPreferences prefs = requireContext().getSharedPreferences("tavern-apk", 0);
                if (!prefs.getBoolean("entered", false)) {
                    prefs.edit().putBoolean("entered", true).apply();
                    ui.post(this::enterWeb);
                }
            }
            String localUrl = webEntryUrl();''')
    # 首次只自动发起一次；失败后由启动按钮重试，避免恢复界面时无限重试。
    replace(launch, '        ui.post(refreshState);', '''        ui.post(refreshState);
        android.content.SharedPreferences prefs = requireContext().getSharedPreferences("tavern-apk", 0);
        if (!prefs.getBoolean("started", false)) {
            prefs.edit().putBoolean("started", true).apply();
            ui.post(() -> {
                View view = getView();
                if (view != null && isResumed()) doStart(requireActivity(),
                        view.findViewById(R.id.launch_status), view.findViewById(R.id.launch_start));
            });
        }''')
    # 独立包不可接受上游 DSHA 的 APK 更新；Tavern 内的源码更新保持原样。
    update = java / 'core/UpdateEngine.java'
    replace(update, '    private void check(boolean startup) {', '''    private void check(boolean startup) {
        if (com.deepseekharness.app.BuildConfig.APPLICATION_ID.equals("io.github.flizzywine.dshtavern")) {
            if (!startup) finishState("idle", "酒馆代码请在酒馆内更新；安卓安装包请从 DSH Tavern 发布页下载。");
            return;
        }''')
    shutil.copyfile(source / 'LICENSE', assets / 'DSHA-LICENSE.txt')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--apk', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    prepare(args.source.resolve(), args.apk.resolve(), args.output.resolve())
