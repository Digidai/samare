import AppKit
import WebKit

enum FinderDropPlan: Equatable {
  case documents([URL])
  case workspace(URL)
  case images([URL])
  case rejected(String)

  static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp"]

  static func classify(_ urls: [URL]) -> FinderDropPlan {
    enum Kind: Hashable { case folder, document, image, unsupported, missing }
    var kinds = Set<Kind>()
    guard !urls.isEmpty else { return .rejected("Samare opens Markdown and text files") }
    let items = urls.map { DocumentStore.canonical($0.path) }
    for (source, item) in zip(urls, items) {
      guard source.isFileURL,
        let info = try? item.resourceValues(forKeys: [.isDirectoryKey, .isRegularFileKey])
      else {
        kinds.insert(.missing)
        continue
      }
      if info.isDirectory == true {
        kinds.insert(.folder)
      } else if info.isRegularFile != true {
        kinds.insert(.unsupported)
      } else if DocumentStore.extensions.contains(item.pathExtension.lowercased()) {
        kinds.insert(.document)
      } else if imageExtensions.contains(item.pathExtension.lowercased()) {
        kinds.insert(.image)
      } else {
        kinds.insert(.unsupported)
      }
    }
    guard kinds.count == 1, let kind = kinds.first else {
      return .rejected("Drop one kind of item at a time")
    }
    switch kind {
    case .folder:
      return items.count == 1 ? .workspace(items[0]) : .rejected("Drop one folder at a time")
    case .document: return .documents(items)
    case .image: return .images(items)
    case .missing: return .rejected("Dropped items are unavailable")
    case .unsupported: return .rejected("Samare opens Markdown and text files")
    }
  }

  var feedback: (kind: String, label: String) {
    switch self {
    case .documents(let items):
      return (
        "documents",
        items.count == 1 ? "Open " + items[0].lastPathComponent : "Open \(items.count) documents"
      )
    case .workspace(let url):
      return ("workspace", "Open " + url.lastPathComponent + " as a workspace")
    case .images(let items):
      return ("images", items.count == 1 ? "Insert image" : "Insert \(items.count) images")
    case .rejected(let reason): return ("rejected", reason)
    }
  }

  // Web-content drags carry text or private tab types. Finder supplies real file URL pasteboard items.
  static func fileURLs(in pasteboard: NSPasteboard) -> [URL]? {
    if let items = pasteboard.pasteboardItems,
      items.contains(where: { $0.types.contains(.fileURL) })
    {
      let urls = items.compactMap { $0.string(forType: .fileURL).flatMap(URL.init(string:)) }
      return urls.count == items.count ? urls : []
    }
    let filenames = NSPasteboard.PasteboardType("NSFilenamesPboardType")
    guard let paths = pasteboard.propertyList(forType: filenames) as? [String] else { return nil }
    guard paths.allSatisfy({ $0.hasPrefix("/") && !$0.contains("\0") }) else { return [] }
    return paths.map { URL(fileURLWithPath: $0) }
  }
}

struct FinderImageImport {
  private struct Copy {
    let url: URL
    let identifier: AnyHashable?
    let size: Int?
    let modified: Date?
  }
  private var copies = [Copy]()
  private var createdDirectory: (url: URL, identifier: AnyHashable)?
  private(set) var images = [[String: String]]()

  mutating func materialize(_ sources: [URL], under root: URL, for document: URL) throws {
    let fm = FileManager.default
    guard DocumentStore.contains(root, document), fm.isWritableFile(atPath: document.path),
      (try? document.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true
    else { throw HostError("The document must be writable and inside an open workspace.") }
    let assets = root.appendingPathComponent("assets", isDirectory: true)
    for source in sources {
      let file = DocumentStore.canonical(source.path)
      let ext = file.pathExtension.lowercased()
      guard FinderDropPlan.imageExtensions.contains(ext),
        (try? file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true
      else { throw HostError("Dropped image is unavailable.") }
      let alt = file.deletingPathExtension().lastPathComponent
      let target: URL
      if DocumentStore.contains(root, file) {
        target = file
      } else {
        if mkdir(assets.path, 0o755) == 0 {
          if let resourceID = try assets.resourceValues(forKeys: [.fileResourceIdentifierKey])
            .fileResourceIdentifier as? AnyHashable
          {
            createdDirectory = (assets, resourceID)
          }
        } else if errno != EEXIST {
          throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        guard DocumentStore.canonical(assets.path).path == assets.standardizedFileURL.path else {
          throw HostError("The workspace assets directory must be inside the workspace.")
        }
        let normalized = alt.lowercased().replacingOccurrences(
          of: "[^a-z0-9]+", with: "-", options: .regularExpression
        )
        .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        let stem = normalized.isEmpty ? "image" : normalized
        var index = 1
        while true {
          let suffix = index == 1 ? "" : "-\(index)"
          let name = assets.appendingPathComponent(stem + suffix + "." + ext)
          do { try fm.copyItem(at: file, to: name) } catch let error as NSError
            where error.domain == NSCocoaErrorDomain
            && error.code == CocoaError.fileWriteFileExists.rawValue
          {
            index += 1
            continue
          }
          let record = try name.resourceValues(forKeys: [
            .fileResourceIdentifierKey, .fileSizeKey, .contentModificationDateKey,
          ])
          copies.append(
            Copy(
              url: name, identifier: record.fileResourceIdentifier as? AnyHashable,
              size: record.fileSize, modified: record.contentModificationDate))
          target = name
          break
        }
      }
      let folder = document.deletingLastPathComponent().pathComponents
      let filePath = target.pathComponents
      let shared = zip(folder, filePath).prefix(while: { $0 == $1 }).count
      let upward = folder.count - shared
      let parts =
        (upward == 0 ? ["."] : Array(repeating: "..", count: upward))
        + Array(filePath.dropFirst(shared))
      let reference = parts.joined(separator: "/").replacingOccurrences(of: "%", with: "%25")
        .replacingOccurrences(of: "#", with: "%23").replacingOccurrences(of: "?", with: "%3F")
      images.append(["src": reference, "alt": alt])
    }
  }

  func discardCopies() {
    for file in copies {
      guard
        let record = try? file.url.resourceValues(forKeys: [
          .fileResourceIdentifierKey, .fileSizeKey, .contentModificationDateKey,
        ]),
        let id = file.identifier, record.fileResourceIdentifier as? AnyHashable == id,
        record.fileSize == file.size, record.contentModificationDate == file.modified
      else { continue }
      try? FileManager.default.removeItem(at: file.url)
    }
    if let directory = createdDirectory,
      (try? directory.url.resourceValues(forKeys: [.fileResourceIdentifierKey])
        .fileResourceIdentifier) as? AnyHashable == directory.identifier
    {
      _ = rmdir(directory.url.path)
    }
  }
}

final class FinderDropWebView: WKWebView {
  weak var dropHost: SamareHost?
  private var current: FinderDropPlan?
  private var lastPoint: CGPoint?
  private var pageAllowsDrop = true
  private var revision = 0

  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    if window != nil && !registeredDraggedTypes.contains(.fileURL) {
      registerForDraggedTypes(registeredDraggedTypes + [.fileURL])
    }
  }

  private func callPage(
    _ method: String, _ payload: [String: Any], completion: ((Bool) -> Void)? = nil
  ) {
    callAsyncJavaScript(
      "return window.SamareFinderDrop?.[method](payload) === true;",
      arguments: ["method": method, "payload": payload], in: nil, in: .page
    ) { result in
      completion?((try? result.get()) as? Bool == true)
    }
  }

  private func payload(_ plan: FinderDropPlan, _ point: CGPoint) -> [String: Any] {
    var values: [String: Any] = [
      "kind": plan.feedback.kind, "label": plan.feedback.label, "x": point.x, "y": point.y,
    ]
    if case .images = plan, let host = dropHost, let target = host.dropImageTarget {
      values["path"] = target.note.path
    }
    return values
  }

  private func location(_ sender: NSDraggingInfo) -> CGPoint {
    let point = convert(sender.draggingLocation, from: nil)
    return CGPoint(x: point.x, y: isFlipped ? point.y : bounds.height - point.y)
  }

  private func update(_ sender: NSDraggingInfo, _ plan: FinderDropPlan) -> NSDragOperation {
    let point = location(sender)
    if lastPoint != point {
      lastPoint = point
      revision += 1
      let request = revision
      callPage("preview", payload(plan, point)) { [weak self] allowed in
        if self?.revision == request { self?.pageAllowsDrop = allowed }
      }
    }
    if case .rejected = plan { return [] }
    return pageAllowsDrop && window?.attachedSheet == nil && dropHost?.isReady == true ? .copy : []
  }

  private func clear() {
    revision += 1
    current = nil
    lastPoint = nil
    pageAllowsDrop = true
    callPage("clear", [:])
  }

  override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
    guard sender.draggingSource == nil,
      let urls = FinderDropPlan.fileURLs(in: sender.draggingPasteboard)
    else { return super.draggingEntered(sender) }
    let plan = FinderDropPlan.classify(urls)
    current = plan
    lastPoint = nil
    pageAllowsDrop = true
    return update(sender, plan)
  }

  override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
    guard let plan = current else { return super.draggingUpdated(sender) }
    return update(sender, plan)
  }

  override func draggingExited(_ sender: NSDraggingInfo?) {
    guard current != nil else {
      super.draggingExited(sender)
      return
    }
    clear()
  }

  override func draggingEnded(_ sender: NSDraggingInfo) {
    if current != nil { clear() }
    super.draggingEnded(sender)
  }

  override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool {
    guard let plan = current else { return super.prepareForDragOperation(sender) }
    return !update(sender, plan).isEmpty
  }

  override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
    guard current != nil else { return super.performDragOperation(sender) }
    defer { clear() }
    guard let host = dropHost, host.isReady, window?.attachedSheet == nil,
      let urls = FinderDropPlan.fileURLs(in: sender.draggingPasteboard)
    else { return false }
    let plan = FinderDropPlan.classify(urls)
    if case .rejected = plan { return false }
    let info = payload(plan, location(sender))
    callPage("prepare", info) { [weak self, weak host] allowed in
      guard allowed, let self, let host else { return }
      switch plan {
      case .documents(let urls):
        for url in urls {
          do { try host.open(url) } catch { host.fail(error.localizedDescription) }
        }
      case .workspace(let url):
        do { try host.open(url) } catch { host.fail(error.localizedDescription) }
      case .images(let sources):
        guard let target = host.dropImageTarget, info["path"] as? String == target.note.path else {
          return
        }
        let queue = host.dropQueue
        queue.async {
          var batch = FinderImageImport()
          do { try batch.materialize(sources, under: target.root, for: target.note) } catch {
            batch.discardCopies()
            DispatchQueue.main.async { host.fail(error.localizedDescription) }
            return
          }
          let imported = batch
          DispatchQueue.main.async {
            guard let stillOpen = host.dropImageTarget, stillOpen.note == target.note,
              stillOpen.root == target.root
            else {
              queue.async { imported.discardCopies() }
              return
            }
            var selection = info
            selection["images"] = imported.images
            self.callPage("insert", selection) { success in
              if !success {
                queue.async { imported.discardCopies() }
                host.fail("The image could not be inserted into this document.")
              }
            }
          }
        }
      case .rejected: break
      }
    }
    return true
  }
}

extension SamareHost {
  var dropImageTarget: (note: URL, root: URL)? {
    guard !activePath.isEmpty, let note = try? store.file(activePath),
      !["txt", "csv", "tsv", "json", "jsonl", "ndjson"].contains(note.pathExtension.lowercased()),
      let root = store.folders.filter({ DocumentStore.contains($0, note) }).max(by: {
        $0.path.count < $1.path.count
      }),
      FileManager.default.isWritableFile(atPath: note.path)
    else { return nil }
    return (note, root)
  }
}
