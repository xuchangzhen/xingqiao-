import AppKit
import UniformTypeIdentifiers
import WebKit

@MainActor
final class BrowserWindowController: NSWindowController, WKNavigationDelegate, NSWindowDelegate {
    private let bridge: DesktopBridge
    private let webView: NativeFileDragWebView
    private let updateService = DesktopUpdateService()
    private weak var shelf: InboxPanelController?
    private let versionLabel = NSTextField(labelWithString: "")
    private let updateButton = NSButton(title: "检查更新", target: nil, action: nil)
    private var endpoint: URL?

    init(store: TempInboxStore, shelf: InboxPanelController) {
        self.shelf = shelf
        bridge = DesktopBridge(store: store, shelf: shelf)
        let configuration = WKWebViewConfiguration()
        // The web shell always comes from the deployed endpoint. A non-persistent
        // data store prevents a desktop upgrade from reviving stale JavaScript,
        // styles or transfer protocol state from a previous version.
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.addScriptMessageHandler(
            bridge,
            contentWorld: .page,
            name: DesktopBridge.handlerName
        )
        configuration.userContentController.addUserScript(WKUserScript(
            source: DesktopBridge.bootstrapScript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        webView = NativeFileDragWebView(
            frame: .zero,
            configuration: configuration,
            fileURL: { id in store.file(id: id)?.path },
            didClick: { shelf.show() }
        )
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1060, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "星桥"
        window.minSize = NSSize(width: 720, height: 560)
        super.init(window: window)
        webView.translatesAutoresizingMaskIntoConstraints = false
        let root = NSView()
        let header = NSView()
        let titleLabel = NSTextField(labelWithString: "星桥")
        let spacer = NSView()
        let headerStack = NSStackView(views: [titleLabel, versionLabel, spacer, updateButton])
        header.translatesAutoresizingMaskIntoConstraints = false
        headerStack.translatesAutoresizingMaskIntoConstraints = false
        titleLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        versionLabel.stringValue = "版本 v\(DesktopUpdateService.currentVersion)"
        versionLabel.font = .systemFont(ofSize: 11)
        versionLabel.textColor = .secondaryLabelColor
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        headerStack.orientation = .horizontal
        headerStack.alignment = .centerY
        headerStack.spacing = 9
        updateButton.bezelStyle = .rounded
        updateButton.target = self
        updateButton.action = #selector(checkForUpdates)
        header.addSubview(headerStack)
        root.addSubview(header)
        root.addSubview(webView)
        window.contentView = root
        NSLayoutConstraint.activate([
            header.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            header.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            header.topAnchor.constraint(equalTo: root.topAnchor),
            header.heightAnchor.constraint(equalToConstant: 40),
            headerStack.leadingAnchor.constraint(equalTo: header.leadingAnchor, constant: 14),
            headerStack.trailingAnchor.constraint(equalTo: header.trailingAnchor, constant: -14),
            headerStack.centerYAnchor.constraint(equalTo: header.centerYAnchor),
            webView.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            webView.topAnchor.constraint(equalTo: header.bottomAnchor),
            webView.bottomAnchor.constraint(equalTo: root.bottomAnchor),
        ])
        webView.navigationDelegate = self
        window.delegate = self
        bridge.nativeDragTargetHandler = { [weak self] targets in self?.webView.updateNativeDragTargets(targets) }
        bridge.checkForUpdateHandler = { [weak self] in self?.checkForUpdates() }
        bridge.pendingReceiveCountHandler = { [weak shelf] count in shelf?.updatePendingReceives(count) }
    }

    required init?(coder: NSCoder) { nil }

    func open() {
        guard let url = configuredEndpoint() else {
            promptForEndpoint()
            return
        }
        if webView.url == nil { load(url) }
        show()
    }

    func show() {
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func reloadFromOrigin() { webView.reloadFromOrigin() }

    /// Accept the first visible transfer from the always-connected hidden web
    /// shell. The main window stays hidden, so this can be used from the tray
    /// or the floating inbox without opening the dashboard.
    func acceptNextWaitingTransfer() {
        runQuickAction(
            "window.XingqiaoQuickActions?.acceptNext?.() ?? 'needs-update'",
            success: "正在建立接收连接…",
            unavailable: "暂无等待接收的内容，或服务器网页尚未更新。"
        )
    }

    /// The floating inbox can begin a send without showing the dashboard. The
    /// selected URLs remain native files; JavaScript streams only the next
    /// transfer block on demand instead of copying an entire file into memory.
    func startQuickSend() {
        guard let shelfWindow = shelf?.window else {
            shelf?.reportQuickAction("发送入口尚未准备好，请稍后重试。")
            return
        }
        let picker = NSOpenPanel()
        picker.title = "选择要通过星桥发送的文件"
        picker.prompt = "加入发送"
        picker.canChooseFiles = true
        picker.canChooseDirectories = false
        picker.allowsMultipleSelection = true
        picker.beginSheetModal(for: shelfWindow) { [weak self] response in
            guard response == .OK, let self else { return }
            let files = self.bridge.registerOutgoingFiles(picker.urls)
            guard !files.isEmpty else {
                self.shelf?.reportQuickAction("没有可发送的文件。")
                return
            }
            do {
                let payload = try JSONSerialization.data(withJSONObject: files)
                guard let json = String(data: payload, encoding: .utf8) else { throw NSError(domain: "星桥", code: 1) }
                self.webView.evaluateJavaScript("window.XingqiaoQuickActions?.addNativeFiles?.(\(json)) ?? 'needs-update'") { [weak self] result, error in
                    Task { @MainActor [weak self] in
                        guard let self else { return }
                        if error != nil || (result as? String) == "needs-update" {
                            self.shelf?.reportQuickAction("网页尚未更新；请刷新后重试。")
                        } else if (result as? String) == "busy" {
                            self.shelf?.reportQuickAction("当前批次正在发送，完成后再添加文件。")
                        } else if (result as? String) == "none" {
                            self.shelf?.reportQuickAction("没有可加入发送区的文件。")
                        } else {
                            self.shelf?.reportQuickAction("已加入 \(files.count) 个文件，可在网页发送区点击“开始发送”。")
                        }
                    }
                }
            } catch {
                self.shelf?.reportQuickAction("无法准备所选文件。")
            }
        }
    }

    private func runQuickAction(_ script: String, success: String, unavailable: String) {
        webView.evaluateJavaScript(script) { [weak self] result, error in
            Task { @MainActor [weak self] in
                guard let self else { return }
                if error != nil || (result as? String) == "needs-update" || (result as? String) == "none" {
                    self.shelf?.reportQuickAction(unavailable)
                } else {
                    self.shelf?.reportQuickAction(success)
                }
            }
        }
    }

    @objc func checkForUpdates() {
        guard updateButton.isEnabled else { return }
        updateButton.isEnabled = false
        updateButton.title = "检查中…"
        updateService.check { [weak self] result in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.updateButton.isEnabled = true
                self.updateButton.title = "检查更新"
                switch result {
                case .latest:
                    self.updateButton.title = "已是最新"
                    self.showUpdateAlert(title: "已是最新版本", message: "当前版本为 v\(DesktopUpdateService.currentVersion)。")
                case .available(let release):
                    self.promptDownload(release)
                case .failed(let message):
                    self.showUpdateAlert(title: "检查更新失败", message: message)
                }
            }
        }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }

    func promptForEndpoint() {
        let alert = NSAlert()
        alert.messageText = "连接星桥网页"
        alert.informativeText = "输入你部署的 HTTPS 星桥网页地址。桌面端每次启动和刷新都会获取该地址的最新网页。"
        let field = NSTextField(string: UserDefaults.standard.string(forKey: "xingqiao.endpoint") ?? "")
        field.placeholderString = "https://transfer.example.com"
        field.frame.size.width = 360
        alert.accessoryView = field
        alert.addButton(withTitle: "连接")
        alert.addButton(withTitle: "取消")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        guard let url = validatedEndpoint(field.stringValue) else {
            showInvalidEndpoint()
            return
        }
        UserDefaults.standard.set(url.absoluteString, forKey: "xingqiao.endpoint")
        load(url)
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
    }

    func webView(_ webView: WKWebView, didFinish _: WKNavigation!) {
        guard let current = webView.url, current.host?.caseInsensitiveCompare(endpoint?.host ?? "") == .orderedSame else {
            bridge.trustedOrigin = nil
            return
        }
        bridge.trustedOrigin = current
    }

    func webView(
        _: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
    ) {
        guard let target = navigationAction.request.url else { decisionHandler(.cancel); return }
        // Blob URLs are renderer-local. Sending one to Finder produces the
        // misleading "no application can open blob:" error; let WebKit handle
        // it as a normal in-page/download navigation instead.
        if target.scheme?.caseInsensitiveCompare("blob") == .orderedSame {
            decisionHandler(.allow)
        } else if target.host?.caseInsensitiveCompare(endpoint?.host ?? "") == .orderedSame {
            decisionHandler(.allow)
        } else if navigationAction.navigationType == .linkActivated {
            NSWorkspace.shared.open(target)
            decisionHandler(.cancel)
        } else {
            decisionHandler(.cancel)
        }
    }

    private func configuredEndpoint() -> URL? {
        guard let raw = UserDefaults.standard.string(forKey: "xingqiao.endpoint") else { return nil }
        return validatedEndpoint(raw)
    }

    private func validatedEndpoint(_ raw: String) -> URL? {
        guard let url = URL(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = url.scheme?.lowercased(),
              let host = url.host,
              (scheme == "https" || (scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(host)))
        else { return nil }
        return url
    }

    private func load(_ url: URL) {
        endpoint = url
        bridge.trustedOrigin = nil
        webView.updateNativeDragTargets([])
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        var query = components?.queryItems ?? []
        query.append(URLQueryItem(name: "xingqiao_desktop", value: "1"))
        components?.queryItems = query
        webView.load(URLRequest(url: components?.url ?? url, cachePolicy: .reloadIgnoringLocalCacheData))
    }

    private func promptDownload(_ release: DesktopRelease) {
        let alert = NSAlert()
        alert.messageText = "发现新版本 v\(release.version)"
        alert.informativeText = "将下载 macOS 更新包到“下载”文件夹。下载后请退出星桥，解压并用新版替换旧 App。"
        alert.addButton(withTitle: "下载更新")
        alert.addButton(withTitle: "稍后")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        updateButton.isEnabled = false
        updateButton.title = "下载 v\(release.version)…"
        updateService.download(release) { [weak self] result in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.updateButton.isEnabled = true
                switch result {
                case .success(let url):
                    self.updateButton.title = "已下载 v\(release.version)"
                    self.showUpdateAlert(title: "更新包已下载", message: "已保存到：\(url.path)\n\n退出星桥后，解压并将新版 App 替换旧版。")
                    NSWorkspace.shared.activateFileViewerSelecting([url])
                case .failed:
                    self.updateButton.title = "检查更新"
                    self.showUpdateAlert(title: "下载更新失败", message: "请检查网络后重试。")
                }
            }
        }
    }

    private func showUpdateAlert(title: String, message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.runModal()
    }

    private func showInvalidEndpoint() {
        let alert = NSAlert()
        alert.messageText = "网页地址无效"
        alert.informativeText = "请输入 HTTPS 地址；开发时只允许 http://localhost 或 127.0.0.1。"
        alert.runModal()
        promptForEndpoint()
    }
}

@MainActor
final class DesktopBridge: NSObject, WKScriptMessageHandlerWithReply {
    static let handlerName = "xingqiaoDesktop"
    static let bootstrapScript = """
    (() => {
      const handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.xingqiaoDesktop;
      if (!handler) return;
      const call = (action, payload = {}) => handler.postMessage({ action, ...payload });
      window.XingqiaoDesktop = Object.freeze({
        beginReceiveFile: (name, mime) => call('beginReceiveFile', { name, mime }),
        writeReceiveChunk: (token, base64) => call('writeReceiveChunk', { token, base64 }),
        finishReceiveFile: token => call('finishReceiveFile', { token }),
        abortReceiveFile: token => call('abortReceiveFile', { token }),
        setTransferActive: active => call('setTransferActive', { active: !!active }),
        showInbox: () => call('showInbox'),
        syncNativeDragTargets: targets => call('syncNativeDragTargets', { targets }),
        checkForUpdate: () => call('checkForUpdate'),
        updateInboxStatus: status => call('updateInboxStatus', { status }),
        readSendFileChunk: (token, offset, length) => call('readSendFileChunk', { token, offset, length }),
        appVersion: () => call('appVersion'),
      });
    })();
    """

    private let store: TempInboxStore
    private weak var shelf: InboxPanelController?
    private var outgoingFiles: [UUID: URL] = [:]
    var trustedOrigin: URL?
    var nativeDragTargetHandler: (([NativeFileDragTarget]) -> Void)?
    var checkForUpdateHandler: (() -> Void)?
    var pendingReceiveCountHandler: ((Int) -> Void)?

    init(store: TempInboxStore, shelf: InboxPanelController) {
        self.store = store
        self.shelf = shelf
    }

    func userContentController(
        _: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void
    ) {
        guard isTrusted(message) else {
            replyHandler(["ok": false, "error": "网页来源未获授权"], nil)
            return
        }
        guard let body = message.body as? [String: Any], let action = body["action"] as? String else {
            replyHandler(["ok": false, "error": "无效请求"], nil)
            return
        }
        do {
            switch action {
            case "beginReceiveFile":
                let name = body["name"] as? String ?? "星桥接收文件"
                let mime = body["mime"] as? String ?? "application/octet-stream"
                let target = try store.begin(name: name, mime: mime)
                replyHandler(["ok": true, "token": target.token, "folder": target.folder, "binary": false], nil)
            case "writeReceiveChunk":
                guard let token = body["token"] as? String, let base64 = body["base64"] as? String else { throw InboxError.unknownToken }
                try store.append(token: token, base64: base64)
                replyHandler(true, nil)
            case "finishReceiveFile":
                guard let token = body["token"] as? String else { throw InboxError.unknownToken }
                let file = try store.finish(token: token)
                shelf?.show()
                replyHandler(["ok": true, "folder": "星桥临时收件箱", "temporary": true, "nativeFileId": file.id.uuidString], nil)
            case "abortReceiveFile":
                if let token = body["token"] as? String { store.abort(token: token) }
                replyHandler(true, nil)
            case "showInbox":
                shelf?.show()
                replyHandler(true, nil)
            case "checkForUpdate":
                checkForUpdateHandler?()
                replyHandler(true, nil)
            case "updateInboxStatus":
                let status = body["status"] as? [String: Any]
                let count = max(0, (status?["waitingReceives"] as? NSNumber)?.intValue ?? 0)
                pendingReceiveCountHandler?(min(count, 99))
                replyHandler(true, nil)
            case "readSendFileChunk":
                guard let token = body["token"] as? String,
                      let offset = (body["offset"] as? NSNumber)?.int64Value,
                      let length = (body["length"] as? NSNumber)?.int64Value
                else { throw InboxError.unknownToken }
                replyHandler(try readOutgoingChunk(token: token, offset: offset, length: length), nil)
            case "appVersion":
                replyHandler(["version": DesktopUpdateService.currentVersion], nil)
            case "setTransferActive":
                replyHandler(true, nil)
            case "syncNativeDragTargets":
                let targets = nativeTargets(from: body["targets"])
                nativeDragTargetHandler?(targets)
                replyHandler(["ok": true, "mapped": targets.count], nil)
            default:
                replyHandler(["ok": false, "error": "未知请求"], nil)
            }
        } catch {
            replyHandler(["ok": false, "error": error.localizedDescription], nil)
        }
    }

    private func isTrusted(_ message: WKScriptMessage) -> Bool {
        guard message.frameInfo.isMainFrame,
              let origin = trustedOrigin,
              let expectedHost = origin.host,
              message.frameInfo.securityOrigin.host.caseInsensitiveCompare(expectedHost) == .orderedSame,
              message.frameInfo.securityOrigin.protocol.caseInsensitiveCompare(origin.scheme ?? "") == .orderedSame
        else { return false }
        return true
    }

    private func nativeTargets(from rawValue: Any?) -> [NativeFileDragTarget] {
        guard let values = rawValue as? [[String: Any]] else { return [] }
        return values.prefix(100).compactMap { value in
            guard let rawID = value["id"] as? String,
                  let fileID = UUID(uuidString: rawID),
                  store.file(id: fileID) != nil,
                  let x = number(value["x"]), let y = number(value["y"]),
                  let width = number(value["width"]), let height = number(value["height"])
            else { return nil }
            return NativeFileDragTarget(fileID: fileID, x: x, y: y, width: width, height: height)
        }
    }

    private func number(_ value: Any?) -> CGFloat? {
        if let number = value as? NSNumber { return CGFloat(truncating: number) }
        if let number = value as? Double { return CGFloat(number) }
        return nil
    }

    func registerOutgoingFiles(_ urls: [URL]) -> [[String: Any]] {
        let limit: Int64 = 4 * 1024 * 1024 * 1024
        return urls.prefix(40).compactMap { url in
            guard url.isFileURL,
                  let values = try? url.resourceValues(forKeys: [.fileSizeKey, .contentTypeKey]),
                  let size = values.fileSize.map(Int64.init), size > 0, size <= limit
            else { return nil }
            let token = UUID()
            outgoingFiles[token] = url
            return [
                "token": token.uuidString,
                "name": url.lastPathComponent,
                "size": size,
                "type": values.contentType?.preferredMIMEType ?? "application/octet-stream",
            ]
        }
    }

    private func readOutgoingChunk(token: String, offset: Int64, length: Int64) throws -> [String: Any] {
        let maximumChunk: Int64 = 8 * 1024 * 1024
        guard let id = UUID(uuidString: token), let url = outgoingFiles[id], offset >= 0, length > 0 else { throw InboxError.unknownToken }
        let size = (try url.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init) ?? 0
        guard offset < size else { return ["ok": true, "base64": "", "bytes": 0] }
        let bytesToRead = Int(min(length, maximumChunk, size - offset))
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(offset))
        let data = try handle.read(upToCount: bytesToRead) ?? Data()
        return ["ok": true, "base64": data.base64EncodedString(), "bytes": data.count]
    }
}
