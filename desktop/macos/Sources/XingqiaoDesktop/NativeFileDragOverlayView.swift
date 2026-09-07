import AppKit

@MainActor
struct NativeFileDragTarget {
    let fileID: UUID
    let x: CGFloat
    let y: CGFloat
    let width: CGFloat
    let height: CGFloat
}

/// Transparent native hit targets placed above the corresponding WebView cards.
/// WebKit may render a DOM drag, but it cannot put arbitrary local file URLs on
/// the macOS pasteboard. These handles start an AppKit file drag instead.
@MainActor
final class NativeFileDragOverlayView: NSView {
    private let fileURL: (UUID) -> URL?
    private let didClick: () -> Void
    private var handles: [UUID: NativeFileDragHandle] = [:]

    init(fileURL: @escaping (UUID) -> URL?, didClick: @escaping () -> Void) {
        self.fileURL = fileURL
        self.didClick = didClick
        super.init(frame: .zero)
        wantsLayer = true
        layer?.backgroundColor = NSColor.clear.cgColor
    }

    required init?(coder: NSCoder) { nil }

    override func hitTest(_ point: NSPoint) -> NSView? {
        for handle in subviews.reversed() {
            let local = handle.convert(point, from: self)
            if let hit = handle.hitTest(local) { return hit }
        }
        return nil
    }

    func update(targets: [NativeFileDragTarget]) {
        let visible = Set(targets.map(\.fileID))
        let staleIDs = handles.keys.filter { !visible.contains($0) }
        for id in staleIDs {
            handles.removeValue(forKey: id)?.removeFromSuperview()
        }

        for target in targets {
            guard target.width > 1, target.height > 1 else { continue }
            let handle = handles[target.fileID] ?? {
                let created = NativeFileDragHandle(fileID: target.fileID, fileURL: fileURL, didClick: didClick)
                addSubview(created)
                handles[target.fileID] = created
                return created
            }()
            // DOM rectangles are measured from the WebView's upper left, while
            // AppKit's default coordinate system starts at the lower left.
            handle.frame = NSRect(
                x: target.x,
                y: bounds.height - target.y - target.height,
                width: target.width,
                height: target.height
            ).intersection(bounds)
        }
    }
}

@MainActor
private final class NativeFileDragHandle: NSView, NSDraggingSource {
    private let fileID: UUID
    private let fileURL: (UUID) -> URL?
    private let didClick: () -> Void
    private var isDraggingFile = false

    init(fileID: UUID, fileURL: @escaping (UUID) -> URL?, didClick: @escaping () -> Void) {
        self.fileID = fileID
        self.fileURL = fileURL
        self.didClick = didClick
        super.init(frame: .zero)
        toolTip = "拖动即可将真实文件交给聊天窗口；点击打开临时收件箱"
    }

    required init?(coder: NSCoder) { nil }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .openHand)
    }

    override func mouseDown(with _: NSEvent) {
        isDraggingFile = false
    }

    override func mouseDragged(with event: NSEvent) {
        guard !isDraggingFile, let url = fileURL(fileID), FileManager.default.fileExists(atPath: url.path) else { return }
        isDraggingFile = true
        let dragImage = NSWorkspace.shared.icon(forFile: url.path)
        dragImage.size = NSSize(width: 56, height: 56)
        let item = NSDraggingItem(pasteboardWriter: url as NSURL)
        item.setDraggingFrame(NSRect(origin: .zero, size: dragImage.size), contents: dragImage)
        beginDraggingSession(with: [item], event: event, source: self)
    }

    override func mouseUp(with _: NSEvent) {
        if !isDraggingFile { didClick() }
    }

    func draggingSession(_: NSDraggingSession, sourceOperationMaskFor _: NSDraggingContext) -> NSDragOperation { .copy }
}
