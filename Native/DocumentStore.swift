import Darwin
import Foundation

struct HostError: LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}

struct DocumentStore {
  static let excludedDirectories = Set([
    "node_modules", "target", "venv", ".venv", "dist", "build", "DerivedData", "Pods",
    "__pycache__",
  ])
  static let extensions = Set([
    "txt", "md", "markdown", "mdown", "mkd", "csv", "tsv", "json", "jsonl", "ndjson",
  ])
  private(set) var folders: [URL] = []
  private(set) var authorized: Set<URL> = []

  static func canonical(_ path: String) -> URL {
    URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath()
  }

  static func isDirectory(_ url: URL) -> Bool {
    (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true
  }

  static func contains(_ parent: URL, _ child: URL) -> Bool {
    child.pathComponents.starts(with: parent.pathComponents)
  }

  static func relocated(_ candidate: URL, from source: URL, to destination: URL) -> URL {
    guard contains(source, candidate) else { return candidate }
    return candidate.pathComponents.dropFirst(source.pathComponents.count).reduce(destination) {
      $0.appendingPathComponent($1)
    }
  }

  mutating func relocateGrants(from source: URL, to destination: URL) {
    folders = folders.map { Self.relocated($0, from: source, to: destination) }
    authorized = Set(authorized.map { Self.relocated($0, from: source, to: destination) })
  }

  mutating func grantFile(_ url: URL) throws -> URL {
    let file = Self.canonical(url.path)
    guard Self.extensions.contains(file.pathExtension.lowercased()), !Self.isDirectory(file) else {
      throw HostError("Unsupported document: \(file.lastPathComponent)")
    }
    authorized.insert(file)
    return file
  }

  mutating func grantFolder(_ url: URL) throws -> URL {
    let folder = Self.canonical(url.path)
    guard Self.isDirectory(folder) else {
      throw HostError("Unable to open folder: \(folder.lastPathComponent)")
    }
    if !folders.contains(folder) { folders.append(folder) }
    return folder
  }

  mutating func closeFolder(_ url: URL) { folders.removeAll { $0 == url } }

  func file(_ path: String) throws -> URL {
    let url = Self.canonical(path)
    guard Self.extensions.contains(url.pathExtension.lowercased()),
      authorized.contains(url) || folders.contains(where: { Self.contains($0, url) })
    else {
      throw HostError("Open this document or its folder first.")
    }
    return url
  }

  func listing(_ url: URL) throws -> [[String: Any]] {
    let root = Self.canonical(url.path)
    guard folders.contains(where: { Self.contains($0, root) }) else {
      throw HostError("Open this workspace first.")
    }
    let keys: Set<URLResourceKey> = [.isDirectoryKey, .isPackageKey, .isRegularFileKey]
    let urls = try FileManager.default.contentsOfDirectory(
      at: root, includingPropertiesForKeys: Array(keys), options: [.skipsHiddenFiles])
    let entries = try urls.compactMap { item -> (URL, Bool)? in
      let info = try item.resourceValues(forKeys: keys)
      let actual = Self.canonical(item.path)
      guard Self.contains(root, actual), info.isPackage != true else { return nil }
      if info.isDirectory == true {
        return Self.excludedDirectories.contains(item.lastPathComponent) ? nil : (actual, true)
      }
      if info.isRegularFile == true && Self.extensions.contains(item.pathExtension.lowercased()) {
        return (actual, false)
      }
      return nil
    }
    return entries.sorted { a, b in
      if a.1 != b.1 { return a.1 }
      return a.0.lastPathComponent.localizedStandardCompare(b.0.lastPathComponent)
        == .orderedAscending
    }.map {
      [
        "path": $0.0.path, "name": $0.0.lastPathComponent, "isDirectory": $0.1,
        "modified":
          (try? $0.0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate?
          .timeIntervalSince1970) ?? 0,
      ]
    }
  }

  func read(_ url: URL) throws -> String {
    let data = try Data(contentsOf: url, options: .mappedIfSafe)
    return try Self.decode(data)
  }

  static func decode(_ data: Data) throws -> String {
    let bom = Data([0xef, 0xbb, 0xbf])
    let bytes = data.starts(with: bom) ? data.dropFirst(3) : data[...]
    guard let text = String(data: bytes, encoding: .utf8) else {
      throw HostError("This file is not UTF-8 text.")
    }
    return text
  }

  enum WriteResult {
    case saved
    case conflict(String)
  }

  func write(_ text: String, to url: URL, replacing base: String) throws -> WriteResult {
    var coordinationError: NSError?
    var outcome: Result<WriteResult, Error>?
    NSFileCoordinator().coordinate(writingItemAt: url, options: [], error: &coordinationError) {
      target in
      outcome = Result {
        try Self.withWriteLock(parent: target.deletingLastPathComponent()) {
          let data = try Data(contentsOf: target)
          let current = try Self.decode(data)
          let crlf =
            current.contains("\r\n")
            && !current.replacingOccurrences(of: "\r\n", with: "").contains("\n")
          func fileText(_ value: String) -> String {
            crlf
              ? value.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(
                of: "\n", with: "\r\n") : value
          }
          let replacement = fileText(text)
          if current.utf8.elementsEqual(replacement.utf8) { return .saved }
          guard current.utf8.elementsEqual(fileText(base).utf8) else { return .conflict(current) }
          var encoded = Data()
          if data.starts(with: [0xef, 0xbb, 0xbf]) {
            encoded.append(contentsOf: [0xef, 0xbb, 0xbf])
          }
          encoded.append(contentsOf: replacement.utf8)
          // Other editors need not take the directory lock.
          let latest = try Data(contentsOf: target)
          guard latest == data else { return .conflict(try Self.decode(latest)) }
          try encoded.write(to: target, options: .atomic)
          return .saved
        }
      }
    }
    if let error = coordinationError { throw error }
    guard let outcome = outcome else { throw HostError("The write could not be coordinated.") }
    return try outcome.get()
  }
  // The companion browser bridge follows the same protocol. Lock the parent
  // inode because an atomic replacement changes the document's own inode.
  private static func withWriteLock<T>(parent: URL, _ body: () throws -> T) throws -> T {
    var fd: Int32 = -1
    repeat {
      // O_EXLOCK takes the same BSD advisory lock as flock(LOCK_EX) atomically
      // with open; closing the descriptor releases it on every return path.
      fd = parent.withUnsafeFileSystemRepresentation {
        Darwin.open($0!, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_EXLOCK)
      }
      if fd < 0 && errno != EINTR {
        let code = errno
        if code == ENOTSUP || code == EOPNOTSUPP { return try body() }
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(code))
      }
    } while fd < 0
    defer { Darwin.close(fd) }
    return try body()
  }

}
