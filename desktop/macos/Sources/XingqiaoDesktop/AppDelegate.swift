import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var store: TempInboxStore!
    private var shelf: InboxPanelController!
    private var browser: BrowserWindowController!
    private var statusItem: NSStatusItem?

    func applicationDidFinishLaunching(_: Notification) {
        do {
            store = try TempInboxStore()
        } catch {
            let alert = NSAlert(error: error)
            alert.runModal()
            NSApp.terminate(nil)
            return
        }
        shelf = InboxPanelController(store: store)
        browser = BrowserWindowController(store: store, shelf: shelf)
        shelf.configureQuickActions(
            acceptPending: { [weak self] in self?.browser.acceptNextWaitingTransfer() },
            sendFiles: { [weak self] in self?.browser.startQuickSend() }
        )
        installMenu()
        browser.open()
    }

    func applicationShouldTerminate(_: NSApplication) -> NSApplication.TerminateReply {
        store.discardAll()
        return .terminateNow
    }

    func applicationShouldTerminateAfterLastWindowClosed(_: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_: NSApplication, hasVisibleWindows: Bool) -> Bool {
        if !hasVisibleWindows { browser.show() }
        return true
    }

    private func installMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        main.addItem(appItem)
        appItem.submenu = makeMenu(includeQuit: true)
        NSApp.mainMenu = main

        let status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        status.button?.title = "✦ 星桥"
        status.menu = makeMenu(includeQuit: true)
        statusItem = status
    }

    private func makeMenu(includeQuit: Bool) -> NSMenu {
        let menu = NSMenu()
        menu.addItem(actionItem("显示星桥", action: #selector(showWindow), keyEquivalent: ""))
        menu.addItem(actionItem("显示临时收件箱", action: #selector(showInbox), keyEquivalent: "i"))
        menu.addItem(actionItem("刷新网页", action: #selector(reloadWeb), keyEquivalent: "r"))
        menu.addItem(actionItem("检查更新…", action: #selector(checkForUpdates), keyEquivalent: ""))
        menu.addItem(actionItem("更改网页地址…", action: #selector(changeEndpoint), keyEquivalent: ","))
        let version = NSMenuItem(title: "当前版本 v\(DesktopUpdateService.currentVersion)", action: nil, keyEquivalent: "")
        version.isEnabled = false
        menu.addItem(version)
        if includeQuit {
            menu.addItem(.separator())
            let quit = NSMenuItem(title: "退出星桥", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
            quit.target = NSApp
            menu.addItem(quit)
        }
        return menu
    }

    private func actionItem(_ title: String, action: Selector, keyEquivalent: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: keyEquivalent)
        item.target = self
        return item
    }

    @objc private func showWindow() { browser.show() }
    @objc private func showInbox() { shelf.show() }
    @objc private func reloadWeb() { browser.reloadFromOrigin() }
    @objc private func checkForUpdates() { browser.checkForUpdates() }
    @objc private func changeEndpoint() { browser.promptForEndpoint() }
}
