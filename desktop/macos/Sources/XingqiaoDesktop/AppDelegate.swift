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
        installMenu()
        browser.open()
    }

    func applicationShouldTerminate(_: NSApplication) -> NSApplication.TerminateReply {
        store.discardAll()
        return .terminateNow
    }

    private func installMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "显示临时收件箱", action: #selector(showInbox), keyEquivalent: "i")
        appMenu.addItem(withTitle: "刷新网页", action: #selector(reloadWeb), keyEquivalent: "r")
        appMenu.addItem(withTitle: "更改网页地址…", action: #selector(changeEndpoint), keyEquivalent: ",")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出星桥", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        NSApp.mainMenu = main

        let status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        status.button?.title = "✦ 星桥"
        status.menu = appMenu.copy() as? NSMenu
        statusItem = status
    }

    @objc private func showInbox() { shelf.show() }
    @objc private func reloadWeb() { browser.reloadFromOrigin() }
    @objc private func changeEndpoint() { browser.promptForEndpoint() }
}
