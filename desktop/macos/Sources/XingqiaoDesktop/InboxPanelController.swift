import AppKit
import QuickLookUI

/// The temporary inbox is intentionally a real native file shelf, not a list
/// of browser downloads. Every row exposes the file URL on the pasteboard so
/// it can be dropped into other native apps such as ChatGPT or Codex.
@MainActor
final class InboxPanelController: NSWindowController, NSTableViewDataSource, NSTableViewDelegate {
    private let store: TempInboxStore
    private let tableView = NSTableView()
    private let emptyLabel = NSTextField(labelWithString: "暂时没有临时文件")
    private let selectionLabel = NSTextField(labelWithString: "未选中文件")
    private let selectAllButton = NSButton(title: "全选", target: nil, action: nil)
    private let previewButton = NSButton(title: "预览", target: nil, action: nil)
    private let saveButton = NSButton(title: "保存选中项到…", target: nil, action: nil)
    private let discardButton = NSButton(title: "移除选中项", target: nil, action: nil)
    private var selectedFileIDs = Set<UUID>()
    private var previewWindow: NSPanel?
    private var previewView: QLPreviewView?

    init(store: TempInboxStore) {
        self.store = store
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 560, height: 370),
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

        let title = NSTextField(labelWithString: "把选中的文件拖到 ChatGPT、Codex 或任何支持文件投放的应用")
        title.font = .systemFont(ofSize: 13, weight: .medium)
        title.lineBreakMode = .byWordWrapping
        title.translatesAutoresizingMaskIntoConstraints = false

        let subtitle = NSTextField(labelWithString: "点击行选中；按 ⌘ 或 ⇧ 可多选。仅“保存选中项”会永久保留文件；退出星桥会清理未保存项。")
        subtitle.textColor = .secondaryLabelColor
        subtitle.font = .systemFont(ofSize: 11)
        subtitle.lineBreakMode = .byWordWrapping
        subtitle.maximumNumberOfLines = 2
        subtitle.translatesAutoresizingMaskIntoConstraints = false

        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("file"))
        column.title = "临时文件"
        column.width = 500
        tableView.addTableColumn(column)
        tableView.headerView = nil
        tableView.delegate = self
        tableView.dataSource = self
        tableView.rowHeight = 56
        tableView.usesAlternatingRowBackgroundColors = true
        tableView.allowsEmptySelection = true
        tableView.allowsMultipleSelection = true
        tableView.doubleAction = #selector(previewSelected)
        tableView.target = self
        tableView.registerForDraggedTypes([.fileURL])
        // Explicitly permit a copy drag outside this process as well as within
        // the shelf; that is what lets a receiving chat obtain the real file.
        tableView.setDraggingSourceOperationMask(.copy, forLocal: true)
        tableView.setDraggingSourceOperationMask(.copy, forLocal: false)

        let scroll = NSScrollView()
        scroll.documentView = tableView
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        scroll.translatesAutoresizingMaskIntoConstraints = false

        emptyLabel.textColor = .secondaryLabelColor
        emptyLabel.alignment = .center
        emptyLabel.translatesAutoresizingMaskIntoConstraints = false

        selectionLabel.font = .systemFont(ofSize: 11)
        selectionLabel.textColor = .secondaryLabelColor
        selectAllButton.target = self
        selectAllButton.action = #selector(selectAllFiles)
        selectAllButton.bezelStyle = .rounded
        previewButton.target = self
        previewButton.action = #selector(previewSelected)
        previewButton.bezelStyle = .rounded
        saveButton.target = self
        saveButton.action = #selector(saveSelected)
        saveButton.bezelStyle = .rounded
        discardButton.target = self
        discardButton.action = #selector(discardSelected)
        discardButton.bezelStyle = .rounded

        let selectionControls = NSStackView(views: [selectionLabel, selectAllButton])
        selectionControls.orientation = .horizontal
        selectionControls.alignment = .centerY
        selectionControls.spacing = 8
        let actions = NSStackView(views: [previewButton, discardButton, saveButton])
        actions.orientation = .horizontal
        actions.spacing = 8
        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let footer = NSStackView(views: [selectionControls, spacer, actions])
        footer.orientation = .horizontal
        footer.alignment = .centerY
        footer.translatesAutoresizingMaskIntoConstraints = false

        root.addSubview(title)
        root.addSubview(subtitle)
        root.addSubview(scroll)
        root.addSubview(emptyLabel)
        root.addSubview(footer)
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
            scroll.bottomAnchor.constraint(equalTo: footer.topAnchor, constant: -14),
            footer.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 16),
            footer.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -16),
            footer.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -14),
            emptyLabel.centerXAnchor.constraint(equalTo: scroll.centerXAnchor),
            emptyLabel.centerYAnchor.constraint(equalTo: scroll.centerYAnchor),
        ])
    }

    private func reload(selectNewest: Bool = false) {
        let files = store.files()
        selectedFileIDs.formIntersection(Set(files.map(\.id)))
        if selectedFileIDs.isEmpty, selectNewest, let newest = files.first {
            selectedFileIDs = [newest.id]
        }
        tableView.reloadData()
        let rows = IndexSet(files.enumerated().compactMap { selectedFileIDs.contains($0.element.id) ? $0.offset : nil })
        if rows.isEmpty {
            tableView.deselectAll(nil)
        } else {
            tableView.selectRowIndexes(rows, byExtendingSelection: false)
        }
        updateControls()
    }

    private func updateControls() {
        let files = store.files()
        let count = selectedFiles.count
        emptyLabel.isHidden = !files.isEmpty
        selectionLabel.stringValue = count == 0 ? "未选中文件" : "已选中 \(count) 项"
        selectAllButton.isEnabled = !files.isEmpty
        selectAllButton.title = count == files.count && !files.isEmpty ? "取消全选" : "全选"
        previewButton.isEnabled = count > 0
        saveButton.isEnabled = count > 0
        discardButton.isEnabled = count > 0
    }

    private var selectedFiles: [TransferFile] {
        let files = store.files()
        return tableView.selectedRowIndexes.compactMap { row in
            guard row >= 0, row < files.count else { return nil }
            return files[row]
        }
    }

    func numberOfRows(in _: NSTableView) -> Int { store.files().count }

    func tableView(_: NSTableView, viewFor _: NSTableColumn?, row: Int) -> NSView? {
        let identifier = NSUserInterfaceItemIdentifier("file-cell")
        let cell = (tableView.makeView(withIdentifier: identifier, owner: self) as? NSTableCellView) ?? makeFileCell(identifier: identifier)
        let file = store.files()[row]
        cell.imageView?.image = NSWorkspace.shared.icon(forFile: file.path.path)
        cell.textField?.stringValue = file.name
        (cell.viewWithTag(101) as? NSTextField)?.stringValue = "\(fileSize(for: file)) · \(fileKind(for: file)) · 拖出即可使用"
        cell.toolTip = "拖到其他应用即可使用；双击或点“预览”可查看。\n暂存位置：\(file.path.path)"
        return cell
    }

    private func makeFileCell(identifier: NSUserInterfaceItemIdentifier) -> NSTableCellView {
        let cell = NSTableCellView()
        cell.identifier = identifier
        let icon = NSImageView()
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.imageScaling = .scaleProportionallyUpOrDown
        let name = NSTextField(labelWithString: "")
        name.translatesAutoresizingMaskIntoConstraints = false
        name.lineBreakMode = .byTruncatingMiddle
        name.font = .systemFont(ofSize: 12, weight: .medium)
        let detail = NSTextField(labelWithString: "")
        detail.translatesAutoresizingMaskIntoConstraints = false
        detail.tag = 101
        detail.textColor = .secondaryLabelColor
        detail.font = .systemFont(ofSize: 10)
        detail.lineBreakMode = .byTruncatingTail
        cell.addSubview(icon)
        cell.addSubview(name)
        cell.addSubview(detail)
        cell.imageView = icon
        cell.textField = name
        NSLayoutConstraint.activate([
            icon.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 9),
            icon.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 34),
            icon.heightAnchor.constraint(equalToConstant: 34),
            name.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 9),
            name.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -9),
            name.bottomAnchor.constraint(equalTo: cell.centerYAnchor, constant: -1),
            detail.leadingAnchor.constraint(equalTo: name.leadingAnchor),
            detail.trailingAnchor.constraint(equalTo: name.trailingAnchor),
            detail.topAnchor.constraint(equalTo: cell.centerYAnchor, constant: 3),
        ])
        return cell
    }

    func tableViewSelectionDidChange(_: Notification) {
        selectedFileIDs = Set(selectedFiles.map(\.id))
        updateControls()
    }

    func tableView(_: NSTableView, pasteboardWriterForRow row: Int) -> NSPasteboardWriting? {
        let files = store.files()
        guard row >= 0, row < files.count, FileManager.default.fileExists(atPath: files[row].path.path) else { return nil }
        // NSURL contributes a real file:// item to the macOS pasteboard. Native
        // chat clients therefore receive the same input as a Finder drag.
        return files[row].path as NSURL
    }

    func tableView(
        _: NSTableView,
        draggingSession _: NSDraggingSession,
        sourceOperationMaskFor _: NSDraggingContext
    ) -> NSDragOperation { .copy }

    @objc private func selectAllFiles() {
        if tableView.numberOfSelectedRows == store.files().count {
            tableView.deselectAll(nil)
        } else {
            tableView.selectAll(nil)
        }
    }

    @objc private func previewSelected() {
        guard let file = selectedFiles.first else { return }
        guard let preview = previewView ?? QLPreviewView(frame: .zero, style: .normal) else { return }
        preview.previewItem = file.path as NSURL
        if previewWindow == nil {
            let panel = NSPanel(
                contentRect: NSRect(x: 0, y: 0, width: 700, height: 520),
                styleMask: [.titled, .closable, .resizable, .utilityWindow],
                backing: .buffered,
                defer: false
            )
            panel.minSize = NSSize(width: 360, height: 260)
            panel.hidesOnDeactivate = false
            preview.autoresizingMask = [.width, .height]
            preview.frame = panel.contentView?.bounds ?? .zero
            panel.contentView?.addSubview(preview)
            previewWindow = panel
            previewView = preview
        }
        previewWindow?.title = "预览 – \(file.name)"
        previewWindow?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func saveSelected() {
        let files = selectedFiles
        guard !files.isEmpty, let window else { return }
        let picker = NSOpenPanel()
        picker.canChooseFiles = false
        picker.canChooseDirectories = true
        picker.allowsMultipleSelection = false
        picker.prompt = "保存选中项到这里"
        picker.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK, let destination = picker.url, let self else { return }
            var failures: [String] = []
            for file in files {
                do { _ = try self.store.save(file: file, to: destination) }
                catch { failures.append("\(file.name)：\(error.localizedDescription)") }
            }
            if failures.isEmpty {
                self.showInfo("已保存 \(files.count) 个选中文件到：\(destination.path)")
            } else {
                self.showError("部分文件未能保存：\n\(failures.joined(separator: "\n"))")
            }
        }
    }

    @objc private func discardSelected() {
        let files = selectedFiles
        guard !files.isEmpty else { return }
        files.forEach(store.discard)
    }

    private func fileSize(for file: TransferFile) -> String {
        let bytes = (try? file.path.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init) ?? 0
        return ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }

    private func fileKind(for file: TransferFile) -> String {
        if file.mime.hasPrefix("image/") { return "图片" }
        if file.mime.hasPrefix("video/") { return "视频" }
        if file.mime.hasPrefix("audio/") { return "音频" }
        if file.mime.hasPrefix("text/") { return "文本" }
        return "文件"
    }

    private func showInfo(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "星桥"
        alert.informativeText = message
        alert.runModal()
    }

    private func showError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "星桥"
        alert.informativeText = message
        alert.runModal()
    }
}
