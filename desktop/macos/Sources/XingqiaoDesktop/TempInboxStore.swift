import Foundation

enum InboxError: LocalizedError {
    case unknownToken
    case invalidName

    var errorDescription: String? {
        switch self {
        case .unknownToken: return "临时接收任务已失效"
        case .invalidName: return "文件名无效"
        }
    }
}

@MainActor
final class TempInboxStore {
    private struct PendingFile {
        let file: TransferFile
        let handle: FileHandle
    }

    private let fileManager = FileManager.default
    private let root: URL
    private let lock = NSLock()
    private var pending: [String: PendingFile] = [:]
    private(set) var received: [TransferFile] = []
    var onChange: (() -> Void)?

    init(root customRoot: URL? = nil) throws {
        if let customRoot {
            root = customRoot
        } else {
            let caches = try fileManager.url(
                for: .cachesDirectory,
                in: .userDomainMask,
                appropriateFor: nil,
                create: true
            )
            root = caches.appendingPathComponent("Xingqiao/Inbox", isDirectory: true)
        }
        // Temp files are deliberately session-scoped. A previous abnormal exit
        // must not leave files behind that the user never chose to save.
        try? fileManager.removeItem(at: root)
        try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
    }

    func begin(name rawName: String, mime: String) throws -> (token: String, folder: String) {
        let name = safeName(rawName)
        guard !name.isEmpty else { throw InboxError.invalidName }
        let token = UUID().uuidString
        let folder = root.appendingPathComponent(token, isDirectory: true)
        try fileManager.createDirectory(at: folder, withIntermediateDirectories: true)
        let path = folder.appendingPathComponent(name, isDirectory: false)
        fileManager.createFile(atPath: path.path, contents: nil)
        let handle = try FileHandle(forWritingTo: path)
        let file = TransferFile(name: name, mime: mime, path: path)
        lock.lock()
        pending[token] = PendingFile(file: file, handle: handle)
        lock.unlock()
        return (token, "星桥临时收件箱")
    }

    func append(token: String, base64: String) throws {
        guard let data = Data(base64Encoded: base64) else { throw CocoaError(.fileReadCorruptFile) }
        lock.lock()
        let item = pending[token]
        lock.unlock()
        guard let item else { throw InboxError.unknownToken }
        try item.handle.write(contentsOf: data)
    }

    func finish(token: String) throws -> TransferFile {
        lock.lock()
        let item = pending.removeValue(forKey: token)
        lock.unlock()
        guard let item else { throw InboxError.unknownToken }
        try item.handle.synchronize()
        try item.handle.close()
        lock.lock()
        received.insert(item.file, at: 0)
        lock.unlock()
        notifyChange()
        return item.file
    }

    func abort(token: String) {
        lock.lock()
        let item = pending.removeValue(forKey: token)
        lock.unlock()
        guard let item else { return }
        try? item.handle.close()
        try? fileManager.removeItem(at: item.file.path.deletingLastPathComponent())
    }

    func save(file: TransferFile, to folder: URL) throws -> TransferFile {
        let target = uniqueURL(in: folder, preferredName: file.name)
        do {
            try fileManager.moveItem(at: file.path, to: target)
        } catch {
            try fileManager.copyItem(at: file.path, to: target)
            try fileManager.removeItem(at: file.path)
        }
        try? fileManager.removeItem(at: file.path.deletingLastPathComponent())
        lock.lock()
        received.removeAll { $0.id == file.id }
        lock.unlock()
        notifyChange()
        return TransferFile(id: file.id, name: target.lastPathComponent, mime: file.mime, path: target, createdAt: file.createdAt)
    }

    func discard(file: TransferFile) {
        try? fileManager.removeItem(at: file.path.deletingLastPathComponent())
        lock.lock()
        received.removeAll { $0.id == file.id }
        lock.unlock()
        notifyChange()
    }

    func discardAll() {
        lock.lock()
        let active = pending
        pending.removeAll()
        received.removeAll()
        lock.unlock()
        active.values.forEach { try? $0.handle.close() }
        try? fileManager.removeItem(at: root)
    }

    func files() -> [TransferFile] {
        lock.lock(); defer { lock.unlock() }
        return received
    }

    private func safeName(_ value: String) -> String {
        let replaced = value
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "\\", with: "_")
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\r", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return replaced.isEmpty ? "星桥接收文件" : replaced
    }

    private func uniqueURL(in folder: URL, preferredName: String) -> URL {
        let extensionName = (preferredName as NSString).pathExtension
        let stem = (preferredName as NSString).deletingPathExtension
        var attempt = 1
        while true {
            let name = attempt == 1
                ? preferredName
                : "\(stem) (\(attempt))\(extensionName.isEmpty ? "" : ".\(extensionName)")"
            let candidate = folder.appendingPathComponent(name)
            if !fileManager.fileExists(atPath: candidate.path) { return candidate }
            attempt += 1
        }
    }

    private func notifyChange() { onChange?() }
}
