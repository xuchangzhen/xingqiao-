import AppKit
import WebKit

@MainActor
struct NativeFileDragTarget {
    let fileID: UUID
    let x: CGFloat
    let y: CGFloat
    let width: CGFloat
    let height: CGFloat
}

/// WebKit consumes gestures before a transparent sibling view can reliably
/// receive them. This view recognizes mapped DOM rectangles at the event
/// source itself and exports the backing temporary file as a normal macOS
/// `file://` drag. Other apps therefore receive a real file, not a `blob:` URL.
@MainActor
final class NativeFileDragWebView: WKWebView, NSDraggingSource {
    private let fileURL: (UUID) -> URL?
    private let didClick: () -> Void
    private var targetsByID: [UUID: NativeFileDragTarget] = [:]
    private var pressedFileID: UUID?
    private var isDraggingFile = false

    init(
        frame: NSRect,
        configuration: WKWebViewConfiguration,
        fileURL: @escaping (UUID) -> URL?,
        didClick: @escaping () -> Void
    ) {
        self.fileURL = fileURL
        self.didClick = didClick
        super.init(frame: frame, configuration: configuration)
    }

    required init?(coder: NSCoder) { nil }

    func updateNativeDragTargets(_ targets: [NativeFileDragTarget]) {
        targetsByID = Dictionary(uniqueKeysWithValues: targets.map { ($0.fileID, $0) })
        if let pressedFileID, targetsByID[pressedFileID] == nil {
            self.pressedFileID = nil
            isDraggingFile = false
        }
    }

    override func mouseDown(with event: NSEvent) {
        guard let fileID = nativeFileID(at: event) else {
            super.mouseDown(with: event)
            return
        }
        pressedFileID = fileID
        isDraggingFile = false
    }

    override func mouseDragged(with event: NSEvent) {
        guard let fileID = pressedFileID else {
            super.mouseDragged(with: event)
            return
        }
        guard !isDraggingFile,
              let url = fileURL(fileID),
              FileManager.default.fileExists(atPath: url.path)
        else { return }

        isDraggingFile = true
        let dragImage = NSWorkspace.shared.icon(forFile: url.path)
        dragImage.size = NSSize(width: 56, height: 56)
        let item = NSDraggingItem(pasteboardWriter: url as NSURL)
        item.setDraggingFrame(NSRect(origin: .zero, size: dragImage.size), contents: dragImage)
        beginDraggingSession(with: [item], event: event, source: self)
    }

    override func mouseUp(with event: NSEvent) {
        guard pressedFileID != nil else {
            super.mouseUp(with: event)
            return
        }
        let wasDragging = isDraggingFile
        pressedFileID = nil
        isDraggingFile = false
        if !wasDragging { didClick() }
    }

    func draggingSession(_: NSDraggingSession, sourceOperationMaskFor _: NSDraggingContext) -> NSDragOperation { .copy }

    private func nativeFileID(at event: NSEvent) -> UUID? {
        let point = convert(event.locationInWindow, from: nil)
        // DOM getBoundingClientRect starts at the upper-left. NSView's default
        // coordinate system starts at the lower-left, so normalize before
        // comparing with coordinates supplied by the web page.
        let domPoint = CGPoint(x: point.x, y: isFlipped ? point.y : bounds.height - point.y)
        return targetsByID.values.first { target in
            NSRect(x: target.x, y: target.y, width: target.width, height: target.height).contains(domPoint)
        }?.fileID
    }
}
