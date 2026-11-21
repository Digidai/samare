import AppKit
import PDFKit
import UniformTypeIdentifiers
import WebKit

struct BridgeSetupRequired: LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

extension SamareHost {
  func grantedItem(_ path: String) throws -> URL {
    let url = DocumentStore.canonical(path)
    if store.folders.contains(where: { DocumentStore.contains($0, url) }) { return url }
    return try store.file(path)
  }
  func parentFolder(_ data: [String: Any]) throws -> URL {
    let path =
      data["parent"] as? String ?? data["directory"] as? String ?? data["path"] as? String
      ?? activeWorkspace
    let parent = try grantedItem(path)
    let folder = DocumentStore.isDirectory(parent) ? parent : parent.deletingLastPathComponent()
    guard store.folders.contains(where: { DocumentStore.contains($0, folder) }) else {
      throw HostError("Choose a workspace for the folder first.")
    }
    return folder
  }
  func itemName(_ given: String?, initial: String, prompt: String) throws -> String? {
    var name = given
    if name == nil {
      let alert = NSAlert()
      alert.messageText = prompt
      let field = NSTextField(string: initial)
      field.frame = NSRect(x: 0, y: 0, width: 320, height: 24)
      alert.accessoryView = field
      alert.addButton(withTitle: "OK")
      alert.addButton(withTitle: "Cancel")
      alert.window.initialFirstResponder = field
      field.selectText(nil)
      if alert.runModal() != .alertFirstButtonReturn { return nil }
      name = field.stringValue
    }
    guard let value = name, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      value != ".", value != "..", !value.contains("/"), !value.contains("\0")
    else { throw HostError("Enter a valid name.") }
    return value
  }
  func createFolder(_ data: [String: Any]) throws {
    let parent = try parentFolder(data)
    guard
      let name = try itemName(
        data["name"] as? String, initial: "Untitled folder", prompt: "New Folder")
    else { return }
    let target = parent.appendingPathComponent(name, isDirectory: true)
    try FileManager.default.createDirectory(at: target, withIntermediateDirectories: false)
    emit("createdFolder", ["path": target.path, "name": name, "parent": parent.path])
    try refresh(parent)
  }
  func refresh(_ parent: URL) throws {
    if store.folders.contains(where: { DocumentStore.contains($0, parent) }) {
      emit("listing", ["path": parent.path, "entries": try store.listing(parent)])
    }
  }
  func rename(_ data: [String: Any]) throws {
    guard let path = data["path"] as? String else { return }
    let old = try grantedItem(path)
    let directory = DocumentStore.isDirectory(old)
    guard
      let name = try itemName(
        data["name"] as? String, initial: old.lastPathComponent, prompt: "Rename")
    else { return }
    if name == old.lastPathComponent { return }
    let parent = old.deletingLastPathComponent()
    let target = parent.appendingPathComponent(name, isDirectory: directory)
    if !directory && !DocumentStore.extensions.contains(target.pathExtension.lowercased()) {
      throw HostError("Keep a supported file extension.")
    }
    try relocate(old, to: target)
  }
  func move(_ data: [String: Any]) throws {
    guard let path = data["path"] as? String, let destination = data["parent"] as? String else {
      throw HostError("Choose a destination folder.")
    }
    let old = try grantedItem(path)
    let parent = try parentFolder(["parent": destination])
    let target = parent.appendingPathComponent(
      old.lastPathComponent, isDirectory: DocumentStore.isDirectory(old))
    guard target.path != old.path else { return }
    guard !DocumentStore.contains(old, target) else {
      throw HostError("A folder cannot be moved inside itself.")
    }
    try relocate(old, to: target)
  }
  func relocate(_ old: URL, to target: URL) throws {
    let directory = DocumentStore.isDirectory(old)
    let name = target.lastPathComponent
    let parent = old.deletingLastPathComponent()
    try FileManager.default.moveItem(at: old, to: target)
    func relocated(_ path: String) -> String {
      guard !path.isEmpty else { return path }
      return DocumentStore.relocated(URL(fileURLWithPath: path), from: old, to: target).path
    }
    store.relocateGrants(from: old, to: target)
    if !directory { _ = try store.grantFile(target) }
    activeWorkspace = relocated(activeWorkspace)
    activePath = relocated(activePath)
    for (index, path) in tabs.enumerated() {
      let next = relocated(path)
      guard next != path else { continue }
      tabs[index] = next
      if let text = lastSeen.removeValue(forKey: path) { track(URL(fileURLWithPath: next), text) }
    }
    if let prefs = defaults, let recent = prefs.stringArray(forKey: "recent") {
      var seen = Set<String>()
      let updated = recent.map(relocated).filter { seen.insert($0).inserted }
      if updated != recent {
        prefs.set(updated, forKey: "recent")
        rebuildRecent()
      }
    }
    emit(
      "renamed", ["oldPath": old.path, "path": target.path, "name": name, "isDirectory": directory])
    foldersChanged()
    try refresh(parent)
    if parent != target.deletingLastPathComponent() {
      try refresh(target.deletingLastPathComponent())
    }
  }
  func trash(_ path: String) throws {
    let item = try grantedItem(path)
    let alert = NSAlert()
    alert.messageText = "Move “\(item.lastPathComponent)” to the Trash?"
    alert.addButton(withTitle: "Move to Trash")
    alert.addButton(withTitle: "Cancel")
    alert.alertStyle = .warning
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    try FileManager.default.trashItem(at: item, resultingItemURL: nil)
    tabs.removeAll { DocumentStore.contains(item, DocumentStore.canonical($0)) }
    for folder in store.folders.filter({ DocumentStore.contains(item, $0) }) {
      store.closeFolder(folder)
    }
    if !tabs.contains(activePath) { activePath = tabs.last ?? "" }
    if !store.folders.contains(where: { $0.path == activeWorkspace }) {
      activeWorkspace = store.folders.first?.path ?? ""
    }
    emit("trashed", ["path": item.path])
    foldersChanged()
    try refresh(item.deletingLastPathComponent())
  }
  func saveAs(_ data: [String: Any], new: Bool) {
    let old = data["path"] as? String
    let parent = try? parentFolder(data)
    let panel = NSSavePanel()
    panel.canCreateDirectories = true
    if let parent {
      panel.directoryURL = parent
    } else if let old, let known = try? store.file(old) {
      panel.directoryURL = known.deletingLastPathComponent()
    }
    panel.nameFieldStringValue =
      data["name"] as? String
      ?? (!new ? old.map { URL(fileURLWithPath: $0).lastPathComponent } : nil) ?? "Untitled.md"
    panel.allowedContentTypes = DocumentStore.extensions.sorted().compactMap {
      UTType(filenameExtension: $0)
    }
    panel.allowsOtherFileTypes = false
    panel.beginSheetModal(for: window) { [weak self] result in
      guard result == .OK, let url = panel.url, let self else { return }
      do {
        let text = data["text"] as? String ?? ""
        try Data(text.utf8).write(to: url, options: .atomic)
        let file = try self.store.grantFile(url)
        try self.publish(file, previous: new ? nil : old)
        try self.refresh(file.deletingLastPathComponent())
      } catch { self.fail(error.localizedDescription) }
    }
  }
  func export(_ type: String, _ data: [String: Any]) {
    let html = data["html"] as? String
    let path = data["path"] as? String ?? activePath
    let title =
      data["title"] as? String
      ?? (path.isEmpty
        ? "Document" : URL(fileURLWithPath: path).deletingPathExtension().lastPathComponent)
    let run: (URL?) -> Void = { [weak self] destination in
      guard let self else { return }
      if type == "exportHTML" {
        guard let destination, let html else {
          self.fail("The HTML document is unavailable.")
          return
        }
        do {
          try Data(self.store.portableHTML(html).utf8).write(to: destination, options: .atomic)
          self.emit("exported", ["path": destination.path])
        } catch { self.fail(error.localizedDescription) }
        return
      }
      let prepare: (String) -> Void = { source in
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(self, forURLScheme: "samareasset")
        config.defaultWebpagePreferences.allowsContentJavaScript = false
        let job = HTMLPrintJob(configuration: config) { view in
          PrintDocument.make(view: view) { result in
            defer { self.printJob = nil }
            do {
              let pdf = try result.get()
              if let destination {
                guard let data = pdf.dataRepresentation() else {
                  throw HostError("Unable to encode the PDF.")
                }
                try data.write(to: destination, options: .atomic)
                self.defaults?.set(destination.deletingLastPathComponent().path, forKey: "lastPDFDirectory")
                self.emit("exported", ["path": destination.path])
              } else if let operation = pdf.printOperation(
                for: .shared, scalingMode: .pageScaleDownToFit, autoRotate: true)
              {
                operation.jobTitle = title
                operation.runModal(for: self.window, delegate: nil, didRun: nil, contextInfo: nil)
              }
            } catch { self.fail(error.localizedDescription) }
          }
        }
        self.printJob = job
        job.load(source)
      }
      if let html {
        prepare(html)
      } else {
        self.web.evaluateJavaScript("document.querySelector('#editor')?.outerHTML || ''") {
          value, error in
          if let source = value as? String {
            prepare(source)
          } else {
            self.fail(error?.localizedDescription ?? "The document is unavailable for printing.")
          }
        }
      }

    }
    if type == "print" {
      run(nil)
      return
    }
    let panel = NSSavePanel()
    let ext = type == "exportHTML" ? "html" : "pdf"
    if type == "exportPDF", let path = defaults?.string(forKey: "lastPDFDirectory") {
      let folder = URL(fileURLWithPath: path)
      if DocumentStore.isDirectory(folder) { panel.directoryURL = folder }
    }
    panel.nameFieldStringValue = title + "." + ext
    panel.allowedContentTypes = [type == "exportHTML" ? .html : .pdf]
    panel.beginSheetModal(for: window) { if $0 == .OK { run(panel.url) } }
  }

  func bridgeEnvironment() -> [String: String] {
    var values = ProcessInfo.processInfo.environment
    if let home = isolatedHome {
      values["SAMARE_BRIDGE_HOME"] = home.appendingPathComponent("Bridge").path
      values["SAMARE_INTEGRATION_HOME"] = home.appendingPathComponent("Home").path
    } else if values["SAMARE_INTEGRATION_HOME"] == nil {
      values["SAMARE_DETECTED_CLIENTS"] = Self.installedAgentApps.joined(separator: ",")
    }
    return values
  }
  func bridge(_ arguments: [String], completion: @escaping (Result<String, Error>) -> Void) {
    guard
      let executable = Bundle.main.resourceURL?.appendingPathComponent(
        "Bridge/samare"), FileManager.default.isExecutableFile(atPath: executable.path)
    else {
      completion(.failure(HostError("The Agent Bridge helper is unavailable in this build.")))
      return
    }
    let environment = bridgeEnvironment()
    bridgeQueue.async {
      let result: Result<String, Error> = Result {
        let process = Process()
        let pipe = Pipe()
        process.executableURL = executable
        process.arguments = arguments
        process.environment = environment
        process.standardOutput = pipe
        process.standardError = pipe
        try process.run()
        let bytes = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let output = String(decoding: bytes, as: UTF8.self).trimmingCharacters(
          in: .whitespacesAndNewlines)
        if process.terminationStatus == 78 { throw BridgeSetupRequired(message: output) }
        guard process.terminationStatus == 0 else {
          throw HostError(output.isEmpty ? "The Agent Bridge helper did not complete." : output)
        }
        return output
      }
      DispatchQueue.main.async { completion(result) }
    }
  }
  private static var installedAgentApps: [String] {
    let bundleIDs = ["codex": "com.openai.codex", "claude": "com.anthropic.claudefordesktop", "cursor": "com.todesktop.230313mzl4w4u92"]
    return bundleIDs.compactMap { name, id in
      NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) == nil ? nil : name
    }.sorted()
  }

  func bridgeStatus() {
    bridge(["doctor", "--json"]) { result in
      do {
        let raw = try result.get()
        guard var value = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any] else {
          throw HostError("Invalid Bridge status.")
        }
        value["error"] = self.bridgeOperationError
        self.lastBridgeStatus = value
        self.emit("bridgeStatus", value)
      } catch {
        var value = self.lastBridgeStatus
        value["error"] = error.localizedDescription
        self.emit("bridgeStatus", value)
      }
    }
  }
  func openBridgeLink(_ url: URL) {
    guard url.scheme == "samare", url.host == "d", url.pathComponents.count == 2 else {
      return
    }
    bridge(["resolve", url.lastPathComponent]) { result in
      do {
        let path = try result.get()
        try self.open(URL(fileURLWithPath: path))
        self.window?.makeKeyAndOrderFront(nil)
      } catch { self.fail(error.localizedDescription) }
    }
  }
}
