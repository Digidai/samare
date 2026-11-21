import AppKit
import UniformTypeIdentifiers

extension SamareHost {
  func windowWillEnterFullScreen(_ notification: Notification) { emit("nativeFullscreen", true) }
  func windowDidEnterFullScreen(_ notification: Notification) { emit("nativeFullscreen", true) }
  func windowWillExitFullScreen(_ notification: Notification) { emit("nativeFullscreen", false) }
  func windowDidFailToExitFullScreen(_ window: NSWindow) { emit("nativeFullscreen", true) }

  func windowDidFailToEnterFullScreen(_ window: NSWindow) {
    emit("nativeFullscreen", false)
    (window as? EditorWindow)?.resumeWindowedControls()
  }

  func windowDidExitFullScreen(_ notification: Notification) {
    emit("nativeFullscreen", false)
    window.makeKeyAndOrderFront(nil)
    if window.firstResponder == nil || window.firstResponder === window { window.makeFirstResponder(web) }
  }
  func windowShouldClose(_ sender: NSWindow) -> Bool {
    if closingAfterFlush || !isReady { return true }
    if pendingFlush == nil {
      beginFlush("close") { [weak self] saved in
        guard let self, saved else { return }
        self.closingAfterFlush = true
        self.window.close()
        self.closingAfterFlush = false
      }
    }
    return false
  }
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    if waitingForQuit { return .terminateLater }
    let editors = sender.windows.compactMap { window -> SamareHost? in
      guard let editor = window.delegate as? SamareHost, editor.window === window, editor.isReady else {
        return nil
      }
      return editor
    }
    guard !editors.isEmpty else { return .terminateNow }
    waitingForQuit = true
    var remaining = editors.count
    var allSaved = true
    for editor in editors {
      editor.beginFlush("quit") { saved in
        allSaved = allSaved && saved
        remaining -= 1
        if remaining == 0 {
          self.waitingForQuit = false
          sender.reply(toApplicationShouldTerminate: allSaved)
        }
      }
    }
    return .terminateLater
  }
  func beginFlush(_ reason: String, completion: @escaping (Bool) -> Void) {
    let id = UUID().uuidString
    pendingFlush = (id, completion)
    emit("flush", ["id": id, "reason": reason])
    DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in
      guard let self, self.pendingFlush?.id == id else { return }
      self.finishedFlush(id: id, ok: false)
      self.fail("The editor is still saving. Try closing again once the file is saved.")
    }
  }
  func finishedFlush(id: String, ok: Bool) {
    guard let request = pendingFlush, request.id == id else { return }
    pendingFlush = nil
    request.completion(ok)
  }
  func restoreFile(_ path: String, _ text: String) throws {
    guard store.authorized.contains(DocumentStore.canonical(path)) || missing.contains(path) else {
      throw HostError("Open the file before restoring it.")
    }
    let file = try store.file(path)
    if FileManager.default.fileExists(atPath: file.path) {
      emit("conflict", ["path": path, "text": try store.read(file)])
      return
    }
    let temp = file.deletingLastPathComponent().appendingPathComponent(".samare-" + UUID().uuidString)
    try Data(text.utf8).write(to: temp, options: .withoutOverwriting)
    defer { try? FileManager.default.removeItem(at: temp) }
    do { try FileManager.default.linkItem(at: temp, to: file) } catch {
      if FileManager.default.fileExists(atPath: file.path) {
        emit("conflict", ["path": path, "text": try store.read(file)])
        return
      }
      throw error
    }
    track(file, text)
    emit("saved", ["path": path, "text": text])
    try refresh(file.deletingLastPathComponent())
  }
  var installedInApplications: Bool {
    let bundle = DocumentStore.canonical(Bundle.main.bundlePath)
    return FileManager.default.urls(for: .applicationDirectory, in: [.localDomainMask, .userDomainMask])
      .contains { DocumentStore.contains(DocumentStore.canonical($0.path), bundle) }
  }
  @available(macOS 12.0, *)
  private var markdownDocumentType: UTType? {
    let documents = Bundle.main.object(forInfoDictionaryKey: "CFBundleDocumentTypes") as? [[String: Any]]
    let markdown = documents?.first { $0["CFBundleTypeName"] as? String == "Markdown Document" }
    let identifier = (markdown?["LSItemContentTypes"] as? [String])?.first ?? "net.daringfireball.markdown"
    return UTType(identifier)
  }
  func defaultStatus() {
    var url: URL?
    if #available(macOS 12.0, *), let markdown = markdownDocumentType {
      url = NSWorkspace.shared.urlForApplication(toOpen: markdown)
    } else if let file = Bundle.main.resourceURL?.appendingPathComponent("Samples/Workspace.md") {
      url = NSWorkspace.shared.urlForApplication(toOpen: file)
    }
    emit(
      "defaultStatus",
      [
        "installedInApplications": installedInApplications,
        "pending": defaultChangePending,
        "error": defaultChangeError ?? "",
        "isDefault": url.flatMap { Bundle(url: $0)?.bundleIdentifier }
          == Bundle.main.bundleIdentifier,
        "name": url?.deletingPathExtension().lastPathComponent ?? "Unknown",
      ])
  }
  func chooseDefault() {
    guard !defaultChangePending, installedInApplications else { defaultStatus(); return }
    guard #available(macOS 12.0, *), let markdown = markdownDocumentType else {
      if let file = Bundle.main.resourceURL?.appendingPathComponent("Samples/Workspace.md") {
        NSWorkspace.shared.activateFileViewerSelecting([file])
      }
      fail("In Finder, choose Get Info → Open with → Change All for a Markdown file.")
      return
    }
    defaultChangeError = nil
    defaultChangePending = true
    defaultStatus()
    NSWorkspace.shared.setDefaultApplication(at: Bundle.main.bundleURL, toOpen: markdown) { error in
      DispatchQueue.main.async {
        self.defaultChangePending = false
        if let error = error as NSError? {
          NSLog("Default Markdown application change failed (%@, %ld).", error.domain, error.code)
          let message = error.localizedDescription.lowercased()
          let denied = error.code == NSUserCancelledError || error.code == -128 || error.code == -54 ||
            ["cancel", "denied", "approv", "permission"].contains(where: { message.contains($0) })
          self.defaultChangeError = denied
            ? "macOS kept the current default app. Select Try Again to request the change."
            : "Samare could not change the default Markdown app. You can try again."
        }
        self.defaultStatus()
      }
    }
  }
  func changeBridge(_ arguments: [String]) {
    bridge(arguments) { result in
      if case .failure(let error) = result {
        self.bridgeOperationError = error.localizedDescription
        self.fail(error.localizedDescription)
      } else {
        self.bridgeOperationError = nil
      }
      self.bridgeStatus()
    }
  }
}
