import AppKit
import Foundation

enum DesktopUpdateCheck: Sendable {
    case latest
    case available(DesktopRelease)
    case failed(String)
}

struct DesktopRelease: Sendable {
    let version: String
    let downloadURL: URL
}

/// The desktop builds use GitHub Releases as their signed, public update
/// catalogue. Downloads are deliberately handed to the user instead of trying
/// to overwrite a running `.app` bundle in place.
final class DesktopUpdateService {
    static let releaseAPI = URL(string: "https://api.github.com/repos/xuchangzhen/xingqiao-/releases/latest")!
    static let macAssetName = "xingqiao-macos-arm64.zip"

    static var currentVersion: String {
        (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "0.0.0"
    }

    func check(completion: @escaping @Sendable (DesktopUpdateCheck) -> Void) {
        var request = URLRequest(url: Self.releaseAPI)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("Xingqiao-macOS-Updater", forHTTPHeaderField: "User-Agent")
        URLSession.shared.dataTask(with: request) { data, response, error in
            let result = Self.parseRelease(data: data, response: response, error: error)
            DispatchQueue.main.async { completion(result) }
        }.resume()
    }

    func download(_ release: DesktopRelease, completion: @escaping @Sendable (DesktopDownloadResult) -> Void) {
        URLSession.shared.downloadTask(with: release.downloadURL) { temporaryURL, _, error in
            do {
                if let error { throw error }
                guard let temporaryURL else { throw UpdateError.downloadUnavailable }
                let destination = try Self.downloadDestination(version: release.version)
                try FileManager.default.moveItem(at: temporaryURL, to: destination)
                DispatchQueue.main.async { completion(.success(destination)) }
            } catch {
                DispatchQueue.main.async { completion(.failed(error.localizedDescription)) }
            }
        }.resume()
    }

    private static func parseRelease(data: Data?, response: URLResponse?, error: Error?) -> DesktopUpdateCheck {
        if let error { return .failed(error.localizedDescription) }
        guard let response = response as? HTTPURLResponse, (200 ..< 300).contains(response.statusCode), let data else {
            return .failed("更新服务暂时不可用")
        }
        do {
            guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let rawVersion = root["tag_name"] as? String
            else { return .failed("更新信息格式无效") }
            let version = rawVersion.trimmingCharacters(in: CharacterSet(charactersIn: "vV"))
            guard !version.isEmpty else { return .failed("更新版本无效") }
            guard isNewer(version, than: currentVersion) else { return .latest }
            let assets = root["assets"] as? [[String: Any]] ?? []
            guard let asset = assets.first(where: { ($0["name"] as? String) == macAssetName }),
                  let rawURL = asset["browser_download_url"] as? String,
                  let downloadURL = URL(string: rawURL)
            else { return .failed("未找到 macOS 更新包") }
            return .available(DesktopRelease(version: version, downloadURL: downloadURL))
        } catch {
            return .failed("无法读取更新信息")
        }
    }

    private static func downloadDestination(version: String) throws -> URL {
        let manager = FileManager.default
        let folder = manager.urls(for: .downloadsDirectory, in: .userDomainMask).first ?? manager.temporaryDirectory
        let base = "星桥-v\(version)-macOS.zip"
        var destination = folder.appendingPathComponent(base)
        var suffix = 2
        while manager.fileExists(atPath: destination.path) {
            destination = folder.appendingPathComponent("星桥-v\(version)-macOS-\(suffix).zip")
            suffix += 1
        }
        return destination
    }

    private static func isNewer(_ candidate: String, than current: String) -> Bool {
        let left = candidate.split(whereSeparator: { $0 == "." || $0 == "-" }).map { Int($0) ?? 0 }
        let right = current.split(whereSeparator: { $0 == "." || $0 == "-" }).map { Int($0) ?? 0 }
        for index in 0 ..< max(left.count, right.count) {
            let a = index < left.count ? left[index] : 0
            let b = index < right.count ? right[index] : 0
            if a != b { return a > b }
        }
        return false
    }

    private enum UpdateError: LocalizedError {
        case downloadUnavailable

        var errorDescription: String? { "更新包下载失败" }
    }
}

enum DesktopDownloadResult: Sendable {
    case success(URL)
    case failed(String)
}
