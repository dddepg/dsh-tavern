# 独立 Android APK

APK 内置 DSHA 的 Ubuntu、Node 和 DSH 运行环境。首次启动通过联网下载
`flizzywine/dsh-tavern` 的最新 `main`，执行仓库中的 Android 安装器。
用户无需输入命令。安装成功才写入完成标记，失败可点击启动重试；日志保存在
容器的 `/root/.dsh/logs/tavern-install.log`。

包名为 `io.github.flizzywine.dshtavern`，与原版 DSHA 可同时安装，数据独立。
现阶段构建标准版，要求 Android 11+、ARM64。原生启动、停止、重启和鉴权直接管理
Tavern Profile。Tavern 的源码更新继续由酒馆管理，安装更新后返回原生界面重启即可。
独立 APK 禁用 DSHA 官方 APK 更新源，避免安装回原版；宿主更新通过重新发布此 APK。

## 构建

需要 Git、Python 3.9+、Node.js 22+、npm、curl、JDK 17+，以及 Android SDK 平台 `android-37.0`
和 Build Tools `37.0.0`。设置 `JAVA_HOME`、`ANDROID_HOME` 后：

```sh
bash android/apk/build.sh
```

脚本下载并验证锁定版本的 DSHA 官方 APK，将其中已经生成的运行环境资产原样复用，
补齐旧 WebView 的 `structuredClone` 后重新编译原生程序。兼容代码使用上游锁文件中的
core-js，并在构建时验证循环引用、Map、Date 和二进制数据的克隆结果。
默认输出 `output/android-apk/dsh-tavern-android-debug.apk` 及 SHA-256。
构建目录独立生成，不修改上游 checkout。

发布时设置 `TAVERN_APK_MODE=Release`、`DSHA_KEYSTORE`、`DSHA_KEYSTORE_PASSWORD`、
`DSHA_KEY_ALIAS`、`DSHA_KEY_PASSWORD`。必须使用酒馆独立、长期保留的签名密钥；
密钥不要提交到仓库。后续 APK 更新必须沿用同一密钥。

DSHA 来源：<https://github.com/DSH-APP/DSHA>，MIT 授权。
锁定提交、官方 APK 摘要见 `prepare.py`，许可证随 APK 一起打包。
