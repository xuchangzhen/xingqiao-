# 星桥互传（Xingqiao）

无需账号的临时文件互传工具，支持照片、视频、文档、剪贴板文字与图片。可在同一局域网运行，也可部署为公网 HTTPS 页面，通过 WebRTC 优先点对点传输。

## 功能

- 相册、文件、社交媒体与剪贴板四种清晰的发送入口。
- 接收方可全选或只勾选所需文件；支持图片缩略图、视频类型标识与文本摘要预览。
- 大批量或大体积视频传输不会生成视频封面；发送页只为少量小型图片生成缩略图，避免 Android WebView 因预览耗尽内存。
- Chrome / Edge 可在接收前选择保存目录，文件会直接写入该目录。
- 发送端关闭会话后，文件无法继续接收；公网模式下文件正文不存入服务器。
- Android 14 WebView 壳，支持系统文件选择器和作为分享目标接收内容。
- Android 14 接收内容会自动分类保存：图片到“图片/星桥”、视频到“视频/星桥”、音频到“音乐/星桥”、其他文件到“下载/星桥”。
- Android App 使用系统自适应图标，并将接收内容通过原生 MediaStore 流式写入，避免网页下载策略因设备不同而失效。
- App 与云端页面均禁用传输逻辑缓存，避免更新后继续运行与原生桥接不兼容的旧网页脚本。
- 若 Android 系统回收 WebView 的媒体渲染进程，App 会自动创建新的页面实例并恢复到可继续选择文件的状态。

## 快速使用

### 局域网模式

任选一台电脑作为协调端，双击：

- macOS：`启动星桥.command`
- Windows：`启动星桥.bat`

其他同一 Wi-Fi 设备打开终端显示的局域网地址即可。关闭协调端网页会结束会话并清理临时文件。

也可手动运行：

```bash
python3 server.py --open
```

### 公网 Web 模式

将 `cloud/` 目录部署到自己的 VPS，并使用自己的子域名和 HTTPS。完整步骤见 [cloud/DEPLOY.md](cloud/DEPLOY.md)。该模式使用 WebSocket 信令和 TURN 兜底；文件优先在两台设备间直传。

## Android

工程位于 `android/`，要求 Android SDK 35 与 JDK 17。Android Studio 通常会自动生成 `local.properties`；也可参考 `android/local.properties.example`。

调试构建：

```bash
cd android
./gradlew assembleDebug
```

发布构建需要自己的签名密钥。复制 `android/keystore.properties.example` 为 `android/keystore.properties`，填入本机 keystore 信息后执行。也可通过 `XINGQIAO_STORE_FILE`、`XINGQIAO_STORE_PASSWORD`、`XINGQIAO_KEY_ALIAS`、`XINGQIAO_KEY_PASSWORD` 环境变量或 Gradle 属性提供签名信息：

```bash
./gradlew assembleRelease
```

为了让新手打开 App 就直接进入星桥，正式发布包还应在构建时注入自己的 HTTPS 网页入口（不会写入仓库）：

```bash
./gradlew assembleRelease -PXINGQIAO_DEFAULT_WEB_URL=https://transfer.example.com
```

没有注入入口的开发包会显示“连接其他星桥”高级入口；不会在首次启动时强制要求填写地址。

在 Android 14 上，“相片与视频”会打开系统照片选择器，而不是文件管理器。社交媒体导入遵循系统授权流程：在微信或 QQ 的聊天中选择内容后点“分享”，选择“星桥”；也可以在星桥内点“打开微信/QQ”后手动完成这一步。第三方应用不会向星桥开放聊天列表或让其代替用户勾选聊天文件。

签名密钥、`keystore.properties`、APK 和本机 SDK 路径均不会提交到仓库。

## 验证

```bash
python3 -m unittest -v tests/test_server.py
python3 -m unittest -v cloud.test_app
./android/gradlew -p "$PWD/android" assembleDebug
```

## 隐私与安全

- 不要将域名、VPS IP、TURN 密钥、签名 keystore 或 `local.properties` 提交到仓库。
- 公网部署必须启用 HTTPS，并将 TURN 密钥保存在服务器的 `.env` 中。
- 请只在已获授权的网络与设备间传输文件。
