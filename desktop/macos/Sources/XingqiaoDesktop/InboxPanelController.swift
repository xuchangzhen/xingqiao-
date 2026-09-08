import AppKit
import QuickLookThumbnailing
import QuickLookUI

/// A native temporary file shelf. Its cards export file:// URLs, just like a
/// Finder drag, so a chat application's file drop target receives a real file.
@MainActor
final class InboxPanelController: NSWindowController, NSCollectionViewDataSource, NSCollectionViewDelegate {
    private let store: TempInboxStore
    private let collectionView = NSCollectionView()
    private let layout = NSCollectionViewFlowLayout()
    private let emptyLabel = NSTextField(labelWithString: "暂时没有临时文件")
    private let selectionLabel = NSTextField(labelWithString: "未选中文件")
    private let receiveButton = NSButton(title: "接收等待项", target: nil, action: nil)
    private let sendButton = NSButton(title: "发送文件", target: nil, action: nil)
    private let selectAllButton = NSButton(title: "全选", target: nil, action: nil)
    private let previewButton = NSButton(title: "预览", target: nil, action: nil)
    private let saveButton = NSButton(title: "保存选中项到…", target: nil, action: nil)
    private let discardButton = NSButton(title: "移除选中项", target: nil, action: nil)
    private var selectedFileIDs = Set<UUID>()
    private var pendingReceiveCount = 0
    private var previewWindow: NSPanel?
    private var previewView: QLPreviewView?
    private var acceptPendingAction: (() -> Void)?
    private var sendFilesAction: (() -> Void)?

    init(store: TempInboxStore) {
        self.store = store
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 760, height: 610),
            styleMask: [.titled, .closable, .resizable, .utilityWindow, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.title = "星桥临时收件箱"
        panel.minSize = NSSize(width: 560, height: 430)
        // Keep the shelf attached to Starbridge's normal window group. It
        // should disappear as soon as another app becomes active instead of
        // remaining above every desktop window.
        panel.isFloatingPanel = false
        panel.level = .normal
        panel.hidesOnDeactivate = true
        panel.collectionBehavior = []
        super.init(window: panel)
        buildInterface(in: panel)
        store.onChange = { [weak self] in self?.reload(selectNewest: true) }
        reload()
    }

    required init?(coder: NSCoder) { nil }

    func configureQuickActions(acceptPending: @escaping () -> Void, sendFiles: @escaping () -> Void) {
        acceptPendingAction = acceptPending
        sendFilesAction = sendFiles
    }

    func updatePendingReceives(_ count: Int) {
        pendingReceiveCount = max(0, count)
        receiveButton.title = count > 0 ? "接收等待项（\(count)）" : "接收等待项"
        updateControls()
    }

    func reportQuickAction(_ message: String) {
        selectionLabel.stringValue = message
    }

    func show() {
        reload()
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func buildInterface(in panel: NSPanel) {
        let root = NSView()
        panel.contentView = root

        let title = NSTextField(labelWithString: "星桥临时收件箱")
        title.font = .systemFont(ofSize: 16, weight: .semibold)
        title.translatesAutoresizingMaskIntoConstraints = false
        let subtitle = NSTextField(labelWithString: "接收后会暂存为真实本地文件：可直接拖到聊天、预览，或只保存你选中的项目。")
        subtitle.font = .systemFont(ofSize: 11)
        subtitle.textColor = .secondaryLabelColor
        subtitle.lineBreakMode = .byTruncatingTail
        subtitle.translatesAutoresizingMaskIntoConstraints = false

        receiveButton.target = self
        receiveButton.action = #selector(receivePending)
        receiveButton.bezelStyle = .rounded
        sendButton.target = self
        sendButton.action = #selector(sendFiles)
        sendButton.bezelStyle = .rounded
        let quickActions = NSStackView(views: [receiveButton, sendButton])
        quickActions.orientation = .horizontal
        quickActions.spacing = 8
        quickActions.translatesAutoresizingMaskIntoConstraints = false

        layout.minimumInteritemSpacing = 12
        layout.minimumLineSpacing = 15
        layout.sectionInset = NSEdgeInsets(top: 12, left: 12, bottom: 16, right: 12)
        layout.itemSize = NSSize(width: 158, height: 166)
        collectionView.collectionViewLayout = layout
        collectionView.dataSource = self
        collectionView.delegate = self
        collectionView.isSelectable = true
        collectionView.allowsMultipleSelection = true
        collectionView.register(FileGridItem.self, forItemWithIdentifier: FileGridItem.identifier)
        collectionView.registerForDraggedTypes([.fileURL])
        collectionView.setDraggingSourceOperationMask(.copy, forLocal: true)
        collectionView.setDraggingSourceOperationMask(.copy, forLocal: false)

        let scroll = NSScrollView()
        scroll.documentView = collectionView
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        scroll.drawsBackground = false
        scroll.translatesAutoresizingMaskIntoConstraints = false

        emptyLabel.alignment = .center
        emptyLabel.textColor = .secondaryLabelColor
        emptyLabel.font = .systemFont(ofSize: 13)
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
        root.addSubview(quickActions)
        root.addSubview(scroll)
        root.addSubview(emptyLabel)
        root.addSubview(footer)
        NSLayoutConstraint.activate([
            title.topAnchor.constraint(equalTo: root.topAnchor, constant: 16),
            title.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 16),
            subtitle.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 4),
            subtitle.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            subtitle.trailingAnchor.constraint(equalTo: quickActions.leadingAnchor, constant: -12),
            quickActions.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -16),
            quickActions.centerYAnchor.constraint(equalTo: title.centerYAnchor),
            scroll.topAnchor.constraint(equalTo: subtitle.bottomAnchor, constant: 14),
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
        if selectedFileIDs.isEmpty, selectNewest, let newest = files.first { selectedFileIDs = [newest.id] }
        collectionView.reloadData()
        let indexes = Set(files.enumerated().compactMap { selectedFileIDs.contains($0.element.id) ? IndexPath(item: $0.offset, section: 0) : nil })
        collectionView.deselectAll(nil)
        if !indexes.isEmpty { collectionView.selectItems(at: indexes, scrollPosition: []) }
        updateControls()
    }

    private func updateControls() {
        let files = store.files()
        let count = selectedFiles.count
        emptyLabel.isHidden = !files.isEmpty
        if count > 0 { selectionLabel.stringValue = "已选中 \(count) 项" }
        else if pendingReceiveCount > 0 { selectionLabel.stringValue = "有 \(pendingReceiveCount) 项等待接收" }
        else { selectionLabel.stringValue = "未选中文件" }
        selectAllButton.isEnabled = !files.isEmpty
        selectAllButton.title = count == files.count && !files.isEmpty ? "取消全选" : "全选"
        previewButton.isEnabled = count > 0
        saveButton.isEnabled = count > 0
        discardButton.isEnabled = count > 0
        receiveButton.isEnabled = acceptPendingAction != nil
        sendButton.isEnabled = sendFilesAction != nil
    }

    private var selectedFiles: [TransferFile] {
        let files = store.files()
        return collectionView.selectionIndexPaths.compactMap { indexPath in
            guard indexPath.section == 0, indexPath.item >= 0, indexPath.item < files.count else { return nil }
            return files[indexPath.item]
        }.sorted { $0.createdAt > $1.createdAt }
    }

    func numberOfSections(in _: NSCollectionView) -> Int { 1 }
    func collectionView(_: NSCollectionView, numberOfItemsInSection _: Int) -> Int { store.files().count }

    func collectionView(_: NSCollectionView, itemForRepresentedObjectAt indexPath: IndexPath) -> NSCollectionViewItem {
        let item = collectionView.makeItem(withIdentifier: FileGridItem.identifier, for: indexPath)
        guard let card = item as? FileGridItem else { return item }
        let files = store.files()
        if indexPath.item < files.count { card.configure(with: files[indexPath.item], size: fileSize(for: files[indexPath.item])) }
        return card
    }

    func collectionView(_: NSCollectionView, didSelectItemsAt _: Set<IndexPath>) {
        selectedFileIDs = Set(selectedFiles.map(\.id))
        updateControls()
    }

    func collectionView(_: NSCollectionView, didDeselectItemsAt _: Set<IndexPath>) {
        selectedFileIDs = Set(selectedFiles.map(\.id))
        updateControls()
    }

    /// NSCollectionView asks permission before it creates a drag session. Be
    /// explicit here: the cards are a file source, never a drop destination.
    func collectionView(_: NSCollectionView, canDragItemsAt indexPaths: Set<IndexPath>, with _: NSEvent) -> Bool {
        let files = store.files()
        return indexPaths.contains { indexPath in
            indexPath.section == 0 && indexPath.item >= 0 && indexPath.item < files.count && FileManager.default.fileExists(atPath: files[indexPath.item].path.path)
        }
    }

    func collectionView(_: NSCollectionView, pasteboardWriterForItemAt indexPath: IndexPath) -> NSPasteboardWriting? {
        let files = store.files()
        guard indexPath.item >= 0, indexPath.item < files.count else { return nil }
        let file = files[indexPath.item]
        guard FileManager.default.fileExists(atPath: file.path.path) else { return nil }
        return file.path as NSURL
    }

    @objc private func receivePending() {
        guard let acceptPendingAction else { return }
        reportQuickAction(pendingReceiveCount > 0 ? "正在接收等待项…" : "正在检查是否有等待接收的内容…")
        acceptPendingAction()
    }

    @objc private func sendFiles() {
        reportQuickAction("打开文件选择器…")
        sendFilesAction?()
    }

    @objc private func selectAllFiles() {
        if collectionView.selectionIndexPaths.count == store.files().count { collectionView.deselectAll(nil) }
        else { collectionView.selectAll(nil) }
    }

    @objc private func previewSelected() {
        guard let file = selectedFiles.first, let preview = previewView ?? QLPreviewView(frame: .zero, style: .normal) else { return }
        preview.previewItem = file.path as NSURL
        if previewWindow == nil {
            let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 760, height: 560), styleMask: [.titled, .closable, .resizable, .utilityWindow], backing: .buffered, defer: false)
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
        picker.prompt = "保存选中项到这里"
        picker.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK, let destination = picker.url, let self else { return }
            var failures: [String] = []
            for file in files {
                do { _ = try self.store.save(file: file, to: destination) }
                catch { failures.append("\(file.name)：\(error.localizedDescription)") }
            }
            if failures.isEmpty { self.showInfo("已保存 \(files.count) 个选中文件到：\(destination.path)") }
            else { self.showError("部分文件未能保存：\n\(failures.joined(separator: "\n"))") }
        }
    }

    @objc private func discardSelected() {
        selectedFiles.forEach(store.discard)
    }

    private func fileSize(for file: TransferFile) -> String {
        let bytes = (try? file.path.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init) ?? 0
        return ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }

    private func showInfo(_ message: String) {
        let alert = NSAlert(); alert.messageText = "星桥"; alert.informativeText = message; alert.runModal()
    }

    private func showError(_ message: String) {
        let alert = NSAlert(); alert.messageText = "星桥"; alert.informativeText = message; alert.runModal()
    }
}

@MainActor
private final class FileGridItem: NSCollectionViewItem {
    static let identifier = NSUserInterfaceItemIdentifier("temporary-file-card")
    private let thumbnail = NSImageView()
    private let checkBadge = NSImageView()
    private let nameLabel = NSTextField(labelWithString: "")
    private let detailLabel = NSTextField(labelWithString: "")
    private var fileID: UUID?

    override func loadView() {
        view = NSView()
        view.wantsLayer = true
        view.layer?.cornerRadius = 12
        view.layer?.borderWidth = 1
        thumbnail.translatesAutoresizingMaskIntoConstraints = false
        thumbnail.wantsLayer = true
        thumbnail.layer?.cornerRadius = 9
        thumbnail.layer?.masksToBounds = true
        thumbnail.imageScaling = .scaleProportionallyUpOrDown
        thumbnail.imageAlignment = .alignCenter
        thumbnail.imageFrameStyle = .none
        checkBadge.translatesAutoresizingMaskIntoConstraints = false
        checkBadge.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 21, weight: .semibold)
        nameLabel.translatesAutoresizingMaskIntoConstraints = false
        nameLabel.alignment = .center
        nameLabel.font = .systemFont(ofSize: 12, weight: .medium)
        nameLabel.lineBreakMode = .byTruncatingMiddle
        detailLabel.translatesAutoresizingMaskIntoConstraints = false
        detailLabel.alignment = .center
        detailLabel.font = .systemFont(ofSize: 10)
        detailLabel.textColor = .secondaryLabelColor
        detailLabel.lineBreakMode = .byTruncatingTail
        view.addSubview(thumbnail)
        view.addSubview(checkBadge)
        view.addSubview(nameLabel)
        view.addSubview(detailLabel)
        NSLayoutConstraint.activate([
            thumbnail.topAnchor.constraint(equalTo: view.topAnchor, constant: 7),
            thumbnail.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 7),
            thumbnail.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -7),
            thumbnail.heightAnchor.constraint(equalTo: thumbnail.widthAnchor, multiplier: 0.62),
            checkBadge.leadingAnchor.constraint(equalTo: thumbnail.leadingAnchor, constant: 7),
            checkBadge.topAnchor.constraint(equalTo: thumbnail.topAnchor, constant: 7),
            checkBadge.widthAnchor.constraint(equalToConstant: 22),
            checkBadge.heightAnchor.constraint(equalToConstant: 22),
            nameLabel.topAnchor.constraint(equalTo: thumbnail.bottomAnchor, constant: 8),
            nameLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 7),
            nameLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -7),
            detailLabel.topAnchor.constraint(equalTo: nameLabel.bottomAnchor, constant: 3),
            detailLabel.leadingAnchor.constraint(equalTo: nameLabel.leadingAnchor),
            detailLabel.trailingAnchor.constraint(equalTo: nameLabel.trailingAnchor),
        ])
        updateSelection()
    }

    override var isSelected: Bool {
        didSet { updateSelection() }
    }

    func configure(with file: TransferFile, size: String) {
        fileID = file.id
        nameLabel.stringValue = file.name
        detailLabel.stringValue = "\(size) · \(dateString(file.createdAt))"
        thumbnail.image = NSWorkspace.shared.icon(forFile: file.path.path)
        requestThumbnail(for: file)
        updateSelection()
        view.toolTip = "拖到 ChatGPT、Codex 或其他应用即可使用。"
    }

    private func requestThumbnail(for file: TransferFile) {
        let request = QLThumbnailGenerator.Request(fileAt: file.path, size: NSSize(width: 300, height: 190), scale: NSScreen.main?.backingScaleFactor ?? 2, representationTypes: .thumbnail)
        QLThumbnailGenerator.shared.generateBestRepresentation(for: request) { [weak self] representation, _ in
            guard let image = representation?.nsImage else { return }
            Task { @MainActor [weak self] in
                guard self?.fileID == file.id else { return }
                self?.thumbnail.image = image
            }
        }
    }

    private func updateSelection() {
        guard isViewLoaded else { return }
        view.layer?.backgroundColor = (isSelected ? NSColor.selectedContentBackgroundColor.withAlphaComponent(0.12) : NSColor.controlBackgroundColor.withAlphaComponent(0.68)).cgColor
        view.layer?.borderColor = (isSelected ? NSColor.controlAccentColor : NSColor.separatorColor.withAlphaComponent(0.42)).cgColor
        view.layer?.borderWidth = isSelected ? 2 : 1
        checkBadge.image = NSImage(systemSymbolName: isSelected ? "checkmark.circle.fill" : "circle", accessibilityDescription: isSelected ? "已选中" : "未选中")
        checkBadge.contentTintColor = isSelected ? .controlAccentColor : .tertiaryLabelColor
    }

    private func dateString(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateFormat = "MM/dd HH:mm"
        return formatter.string(from: date)
    }
}
