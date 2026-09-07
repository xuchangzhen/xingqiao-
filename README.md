# 星桥互传（Xingqiao）

无需账号的临时文件互传工具，支持照片、视频、文档、剪贴板文字与图片。可在同一局域网运行，也可部署为公网 HTTPS 页面，通过 WebRTC 优先点对点传输。

## 功能

- 相册、文件、社交媒体与剪贴板四种清晰的发送入口。
- 接收方可全选或只勾选所需文件；支持图片缩略图、视频类型标识与文本摘要预览。
- 大批量或大体积视频传输不会生成视频封面；发送页只为少量小型图片生成缩略图，避免 Android WebView 因预览耗尽内存。
- 网页端接收的普通图片与文件会准备为短时有效的原生拖拽资源：桌面版 Chrome / Edge 可直接拖到聊天窗口、网页上传区、Finder 或资源管理器；点击资源仍可另存。Safari / Firefox 不支持 Chromium 的原生文件承诺拖拽，跨应用时仍需使用另存。
- 超过 128 MB 的文件不会堆在浏览器内存中：Chrome / Edge 会在接收前选择保存目录并流式写入。目录窗口从“桌面”打开；系统目录受浏览器保护不能写入，请选择桌面或其他普通文件夹。
- 发送端关闭会话后，文件无法继续接收；公网模式下文件正文不存入服务器。
- Android 14 WebView 壳，支持系统文件选择器和作为分享目标接收内容。
- Android 14 接收内容会自动分类保存：图片到“图片/星桥”、视频到“视频/星桥”、音频到“音乐/星桥”、其他文件到“下载/星桥”。
- Android App 使用系统自适应图标，并将接收内容通过原生 MediaStore 流式写入，避免网页下载策略因设备不同而失效。
- macOS 桌面端将点“接收”的文件流式写入本机临时收件箱，并以真实本地文件提供原生拖拽；在内嵌网页的已接收文件卡片或悬浮收件箱中，都可直接拖入 ChatGPT、Codex 等聊天窗口，点击“保存到…”才会永久保留。
- Windows 桌面端同样提供原生悬浮收件箱，可将真实文件拖入聊天窗口；macOS、Windows 和 Android 使用同一套星桥图标。
- macOS 临时收件箱位于系统缓存目录；未保存文件会在退出星桥时清理，异常退出后的残留会在下次启动时清理。
- App 与云端页面均禁用传输逻辑缓存，避免更新后继续运行与原生桥接不兼容的旧网页脚本。
- 若 Android 系统回收 WebView 的媒体渲染进程，App 会自动创建新的页面实例并恢复到可继续选择文件的状态。
- Android App 内可“检查更新”：下载 GitHub Release 中的 APK 后交给系统安装确认；首次安装带此功能的版本仍需手动安装一次。
- Android 传输开始后会显示系统传输通知；切到后台或锁屏仍会继续，用户从任务列表移除星桥或关闭页面时会停止并释放保活资源。
- 为保护移动设备，Android 不生成大图/视频预览，且每批最多 40 个文件；大批内容请分批发送。
- WebRTC 会按 ICE 优先级优先选择局域网主机候选；只有直连候选不可用时才选择 TURN 中转。若希望页面与信令也完全不访问公网，请使用局域网模式。
- 文件传输采用按设备能力调节的有界落盘确认窗口；桌面浏览器批量写盘并保持更深的发送队列，Android Release 使用 ArrayBuffer 原生写入，发送与接收界面都会显示进度、速度和当前文件。

## 快速使用

### 局域网模式

任选一台电脑作为协调端，双击：

- macOS：`启动星桥.command`
- Windows：`启动星桥.bat`

其他同一 Wi-Fi 设备打开终端显示的局域网地址即可。关闭协调端网页会结束会话并清理临时文件。

局域网模式的页面、信令和文件正文都只在本地网络内流动。浏览器发送采用原始文件并行上传，接收方可在上传尚未结束时同步下载；协调端不会再为每个文件做一次完整的临时文件复制。速度仍由 Wi-Fi/网口、路由器和设备性能决定。

它不受宽带套餐速率限制，但也不等于某台设备标称网卡速度：实际上限取决于参与设备中最慢的一段链路。若协调端是第三台 Wi-Fi 设备，文件会经过两段无线传输、占用两次空口时间，吞吐通常会明显低于 Wi-Fi 的协商速率；让发送端或协调端使用千兆有线网络通常最快。

公网 Web 模式也会优先选择局域网候选；只有直连路径不可用时才会使用 TURN。页面会显示“局域网直连传输”或“公网中转传输”，便于确认实际路径。

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

若要启用应用内更新，还需在签名 Release 构建时注入自己公开仓库的“最新 Release API”地址；此地址同样不会写入仓库。例如：

```bash
./gradlew assembleRelease \
  -PXINGQIAO_DEFAULT_WEB_URL=https://transfer.example.com \
  -PXINGQIAO_UPDATE_API_URL=https://api.github.com/repos/your-org/your-repo/releases/latest
```

每个 Release 必须上传一个 `.apk` 资产，标签使用递增的 `v1.2.3` 格式。Android 出于安全要求仍会显示系统安装确认；首次更新时也可能要求允许“星桥安装未知应用”。

在 Android 14 上，“相片与视频”会打开系统照片选择器，而不是文件管理器。社交媒体导入遵循系统授权流程：在微信或 QQ 的聊天中选择内容后点“分享”，选择“星桥”；也可以在星桥内点“打开微信/QQ”后手动完成这一步。第三方应用不会向星桥开放聊天列表或让其代替用户勾选聊天文件。

签名密钥、`keystore.properties`、APK 和本机 SDK 路径均不会提交到仓库。

## macOS 桌面端

桌面端是原生悬浮收件箱加网页传输界面，要求 macOS 14 及以上与 Xcode Command Line Tools。首次启动时输入自己的 HTTPS 星桥地址；该地址仅保存到本机用户偏好中，不会提交到仓库。

接收时，文件会先流式写入 `~/Library/Caches/Xingqiao/Inbox`。在内嵌网页的“已接收”文件卡片或“星桥临时收件箱”悬浮窗中拖动条目，都会向目标应用交付真正的 `file://` 文件，因此可用于 ChatGPT、Codex 和其他支持 macOS 文件投放的应用。点击卡片会打开收件箱；点击“保存到…”才会移到用户选定的永久目录；直接退出星桥会删除尚未保存的临时文件。关闭主窗口只会隐藏到菜单栏，可通过菜单栏的“显示星桥”重新打开。

构建当前 Mac 可运行的 `.app`：

```bash
cd desktop/macos
./build-app.sh
open dist/星桥.app
```

桌面端使用非持久网页缓存，并在每次启动或点“刷新网页”时从部署地址重新获取页面。因此先将同一提交的 `cloud/` 部署到服务器后，所有桌面端无需重新安装即可得到对应的网页更新；桌面端原生能力变更时，再重新构建并分发 `.app`。

## Windows 桌面端

Windows 10/11 版采用 WPF + Microsoft Edge WebView2。它与 macOS 版具有相同的临时文件生命周期：点“接收”后落盘到 `%LOCALAPPDATA%\Xingqiao\Inbox`，从悬浮收件箱拖出的是真实文件；点击“保存到…”才会永久保存，退出时会清理其余临时文件。

在 Windows 上安装 .NET 8 SDK（以及 Edge WebView2 Runtime；Windows 11 与大多数当前 Windows 10 已预装）后构建：

```powershell
cd desktop/windows
./build.ps1
Start-Process ./dist/XingqiaoDesktop.exe
```

首次启动时输入自己的 HTTPS 星桥地址。它也会在启动或点击“刷新网页”时加载服务器上的最新网页，因此网页部署和桌面端不需要分别维护两套传输界面。

## 验证

```bash
python3 -m unittest -v tests/test_server.py
python3 -m unittest -v cloud.test_app
./android/gradlew -p "$PWD/android" assembleDebug
swift build --package-path desktop/macos
# 在 Windows 上：dotnet build desktop/windows/XingqiaoDesktop.csproj
```

## 隐私与安全

- 不要将域名、VPS IP、TURN 密钥、签名 keystore 或 `local.properties` 提交到仓库。
- 公网部署必须启用 HTTPS，并将 TURN 密钥保存在服务器的 `.env` 中。
- 请只在已获授权的网络与设备间传输文件。
