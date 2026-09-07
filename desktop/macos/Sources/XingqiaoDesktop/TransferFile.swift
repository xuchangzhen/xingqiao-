import Foundation

struct TransferFile: Codable, Identifiable, Equatable {
    let id: UUID
    let name: String
    let mime: String
    let path: URL
    let createdAt: Date

    init(id: UUID = UUID(), name: String, mime: String, path: URL, createdAt: Date = .now) {
        self.id = id
        self.name = name
        self.mime = mime
        self.path = path
        self.createdAt = createdAt
    }
}
