package com.deepseekharness.app.core;

import android.content.Context;
import com.deepseekharness.app.runtime.ProotBootstrap;
import com.deepseekharness.app.util.Compat;
import com.deepseekharness.app.util.InstallProcess;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

/** 在现有启动锁内安装；只有完整安装成功后才留下完成标记。 */
public final class TavernBootstrap {
    private TavernBootstrap() { }

    public static void ensure(Context context, ProotBootstrap boot,
                              BooleanSupplier cancelled, Consumer<String> status) throws Exception {
        File root = boot.getRootfsDir();
        File marker = new File(root, "root/.dsh/tavern-apk-installed");
        File profile = new File(root, "root/.dsh/profiles/tavern/package.json");
        File source = new File(root, "root/.dsh/apps/dsh-tavern/bin/dsh-tavern.mjs");
        if (marker.isFile() && profile.isFile() && source.isFile()) return;
        status.accept("首次安装：正在联网下载最新版酒馆，请保持应用打开……");
        File script = new File(root, "root/tavern-apk-setup.sh");
        try (InputStream in = context.getAssets().open("tavern-apk-setup.sh");
             FileOutputStream out = new FileOutputStream(script)) {
            byte[] buffer = new byte[8192]; int count;
            while ((count = in.read(buffer)) != -1) out.write(buffer, 0, count);
        }
        String command = "set -o pipefail; export DSH_TAVERN_ANDROID_STANDALONE=1; mkdir -p /root/.dsh/logs; "
                + "bash /root/tavern-apk-setup.sh 2>&1 | tee /root/.dsh/logs/tavern-install.log";
        int exit = InstallProcess.read(boot.execRootfsForInstall(command), 3600000L,
                true, cancelled, status, Compat::destroy);
        if (exit != 0) throw new java.io.IOException("酒馆安装失败，可点击启动重试；日志：.dsh/logs/tavern-install.log");
        if (!profile.isFile() || !source.isFile()) throw new java.io.IOException("酒馆安装结果不完整，请重试");
        Compat.write(marker, "1\n".getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }
}
