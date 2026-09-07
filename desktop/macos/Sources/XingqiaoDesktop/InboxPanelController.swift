import AppKit

@MainActor
final class InboxPanelController: NSWindowController, NSTableViewDataSource, NSTableViewDelegate {
    private let store: TempInboxStore
    private let tableView = NSTableView()
    private let emptyLabel = NSTextField(labelWithString: "暂时没有临时文件")
    private let saveButton = NSButton(title: "保存到…", target: nil, action: nil)
    private let discardButton = NSButton(title: "移除", target: nil, action: nil)
    private var selectedFileID: UUID?

    init(store: TempInboxStore) {
        self.store = store
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 440, height: 280),
            styleMask: [.titled, .closable, .resizable, .utilityWindow],
            backing: .buffered,
            defer: false
        )
        panel.title = "星桥临时收件箱"
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        super.init(window: panel)
        buildInterface(in: panel)
        store.onChange = { [weak self] in self?.reload(selectNewest: true) }
        reload()
    }

    required init?(coder: NSCoder) { nil }

    func show() {
        reload()
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func buildInterface(in panel: NSPanel) {
        let root = NSView()
        root.translatesAutoresizingMaskIntoConstraints = false
        panel.contentView = root

        let title = NSTextField(labelWithString: "拖动文件到 ChatGPT、Codex 或任意支持文件投放的应用")
        title.font = .systemFont(ofSize: 13, weight: .medium)
        title.lineBreakMode = .byWordWrapping
        title.translatesAutoresizingMaskIntoConstraints = false

        let subtitle = NSTextField(labelWithString: "这些文件仅暂存在星桥；点击“保存到…”后才会永久保留。退出星桥会清理其余文件。")
        subtitle.textColor = .secondaryLabelColor
        subtitle.font = .systemFont(ofSize: 11)
        subtitle.lineBreakMode = .byWordWrapping
        subtitle.maximumNumberOfLines = 2
        subtitle.translatesAutoresizingMaskIntoConstraints = false

        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("file"))
        column.title = "临时文件"
        column.width = 390
        tableView.addTableColumn(column)
        tableView.headerView = nil
        tableView.delegate = self
        tableView.dataSource = self
        tableView.rowHeight = 38
        tableView.usesAlternatingRowBackgroundColors = true
        tableView.allowsEmptySelection = true
        tableView.registerForDraggedTypes([.fileURL])

        let scroll = NSScrollView()
        scroll.documentView = tableView
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        scroll.translatesAutoresizingMaskIntoConstraints = false

        emptyLabel.textColor = .secondaryLabelColor
        emptyLabel.alignment = .center
        emptyLabel.translatesAutoresizingMaskIntoConstraints = false

        saveButton.target = self
        saveButton.action = #selector(saveSelected)
        saveButton.bezelStyle = .rounded
        discardButton.target = self
        discardButton.action = #selector(discardSelected)
        discardButton.bezelStyle = .rounded
        let actions = NSStackView(views: [discardButton, saveButton])
        actions.orientation = .horizontal
        actions.spacing = 8
        actions.translatesAutoresizingMaskIntoConstraints = false

        root.addSubview(title)
        root.addSubview(subtitle)
        root.addSubview(scroll)
        root.addSubview(emptyLabel)
        root.addSubview(actions)
        NSLayoutConstraint.activate([
            title.topAnchor.constraint(equalTo: root.topAnchor, constant: 16),
            title.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 16),
            title.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -16),
            subtitle.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 4),
            subtitle.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            subtitle.trailingAnchor.constraint(equalTo: title.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: subtitle.bottomAnchor, constant: 12),
            scroll.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 16),
            scroll.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -16),
            scroll.bottomAnchor.constraint(equalTo: actions.topAnchor, constant: -14),
            actions.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -16),
            actions.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -14),
            emptyLabel.centerXAnchor.constraint(equalTo: scroll.centerXAnchor),
            emptyLabel.centerYAnchor.constraint(equalTo: scroll.centerYAnchor),
        ])
    }

    private func reload(selectNewest: Bool = false) {
        let files = store.files()
        let requestedID = selectedFileID ?? (selectNewest ? files.first?.id : nil)
        tableView.reloadData()
        if let requestedID, let row = files.firstIndex(where: { $0.id == requestedID }) {
            tableView.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
        } else {
            tableView.deselectAll(nil)
            selectedFileID = nil
        }
        updateControls()
    }

    private func updateControls() {
        let hasFiles = !store.files().isEmpty
        emptyLabel.isHidden = hasFiles
        saveButton.isEnabled = selectedFile != nil
        discardButton.isEnabled = selectedFile != nil
    }

    private var selectedFile: TransferFile? {
        let row = tableView.selectedRow
        let files = store.files()
        return row >= 0 && row < files.count ? files[row] : nil
    }

    func numberOfRows(in _: NSTableView) -> Int { store.files().count }

    func tableView(_: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let identifier = NSUserInterfaceItemIdentifier("file-cell")
        let cell = (tableView.makeView(withIdentifier: identifier, owner: self) as? NSTableCellView) ?? {
            let view = NSTableCellView()
            view.identifier = identifier
            let text = NSTextField(labelWithString: "")
            text.translatesAutoresizingMaskIntoConstraints = false
            text.lineBreakMode = .byTruncatingMiddle
            view.addSubview(text)
            view.textField = text
            NSLayoutConstraint.activate([
                text.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 10),
                text.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -10),
                text.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            ])
            return view
        }()
        let file = store.files()[row]
        let readableSize = ByteCountFormatter.string(fromByteCount: (try? file.path.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init) ?? 0, countStyle: .file)
        cell.textField?.stringValue = "\(file.name)   \(readableSize)"
        cell.toolTip = "拖出即可上传；暂存位置：\(file.path.path)"
        return cell
    }

    func tableViewSelectionDidChange(_: Notification) {
        selectedFileID = selectedFile?.id
        updateControls()
    }

    func tableView(_: NSTableView, pasteboardWriterForRow row: Int) -> NSPasteboardWriting? {
        let files = store.files()
        guard row >= 0, row < files.count, FileManager.default.fileExists(atPath: files[row].path.path) else { return nil }
        // NSURL contributes a real file:// item to the macOS pasteboard. Native
        // chat clients therefore receive the same kind of input as Finder drag.
        return files[row].path as NSURL
    }

    func tableView(
        _: NSTableView,
        draggingSession _: NSDraggingSession,
        sourceOperationMaskFor _: NSDraggingContext
    ) -> NSDragOperation { .copy }

    @objc private func saveSelected() {
        guard let file = selectedFile, let window else { return }
        let picker = NSOpenPanel()
        picker.canChooseFiles = false
        picker.canChooseDirectories = true
        picker.allowsMultipleSelection = false
        picker.prompt = "保存到这里"
        picker.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK, let destination = picker.url else { return }
            do {
                _ = try self?.store.save(file: file, to: destination)
            } catch {
                self?.showError("无法保存文件：\(error.localizedDescription)")
            }
        }
    }

    @objc private func discardSelected() {
        guard let file = selectedFile else { return }
        store.discard(file: file)
    }

    private func showError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "星桥"
        alert.informativeText = message
        alert.runModal()
    }
}
