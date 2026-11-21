import AppKit
import UniformTypeIdentifiers
import WebKit

class SamareHost: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate,
  WKUIDelegate, WKURLSchemeHandler, NSWindowDelegate
{
  var window: EditorWindow!
  var web: WKWebView!
  var store = DocumentStore()
  var tabs: [String] = []
  var activePath = ""
  var activeWorkspace = ""
  var settings: [String: Any] = [:]
  var lastSeen: [String: String] = [:]
  var missing: Set<String> = []
  var trashSelections: [String: [String: TrashIdentity]] = [:]
  var signatures: [String: String] = [:]
  var launchCover: StartupMark?
  var didPresentInterface = false
  var isReady = false
  var pendingRelease = false
  var releaseBuild: Int { Int(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "") ?? 0 }
  var releaseVersion: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.1.1" }
  #if canImport(Sparkle)
  let updates = SamareUpdates()
  #endif
  var watcher: Timer?
  var recentMenu = NSMenu(title: "Open Recent")
  var printJob: HTMLPrintJob?
  var pendingFlush: (id: String, completion: (Bool) -> Void)?
  var waitingForQuit = false
  lazy var isolatedHome: URL? =
    args.contains("--isolated")
    ? FileManager.default.temporaryDirectory.appendingPathComponent(
      "Samare-Isolated-" + UUID().uuidString, isDirectory: true) : nil
  var closingAfterFlush = false
  let args = Array(CommandLine.arguments.dropFirst())
  lazy var defaults: UserDefaults? = args.contains("--isolated") ? nil : UserDefaults.standard
  private var queued: [URL] = []
  var searchQueues: [String: OperationQueue] = [:]
  var watchedFolders: [String: String] = [:]
  let dropQueue = DispatchQueue(label: "io.github.digidai.samare.finder-images", qos: .userInitiated)
  let bridgeQueue = DispatchQueue(label: "io.github.digidai.samare.bridge", qos: .userInitiated)
  var lastBridgeStatus: [String: Any] = [:]
  var bridgeOperationError: String?
  var defaultChangePending = false
  var defaultChangeError: String?

  func applicationDidFinishLaunching(_ notification: Notification) {
    pendingRelease = ReleaseHistory.pending(build: releaseBuild, version: releaseVersion, defaults: defaults)
    restore()
    var files = queued
    var iterator = args.makeIterator()
    while let arg = iterator.next() {
      switch arg {
      case "--file", "--workspace":
        if let path = iterator.next() { files.append(URL(fileURLWithPath: path)) }
      case "--capture": _ = iterator.next()
      case "--isolated", "--quit-after-capture": break
      default:
        if !arg.hasPrefix("-"), FileManager.default.fileExists(atPath: arg) {
          files.append(URL(fileURLWithPath: arg))
        }
      }
    }
    let deepLinks = files.filter { !$0.isFileURL }
    for url in files where url.isFileURL {
      do { try open(url) } catch { NSLog("%@", error.localizedDescription) }
    }
    makeMenus()
    let configuration = WKWebViewConfiguration()
    let appearanceName = settings["theme"] as? String
    let dark = appearanceName == "dark" || (appearanceName == nil && NSApp.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua)
    let theme = dark ? "dark" : "light"
    configuration.userContentController.addUserScript(WKUserScript(
      source: "document.documentElement.dataset.theme = '\(theme)'",
      injectionTime: .atDocumentStart, forMainFrameOnly: true))
    configuration.userContentController.add(self, name: "host")
    configuration.setURLSchemeHandler(self, forURLScheme: "samareasset")
    let editorView = FinderDropWebView(frame: .zero, configuration: configuration)
    editorView.dropHost = self
    web = editorView
    web.uiDelegate = self
    web.navigationDelegate = self
    let background = NSColor(white: dark ? 0.1 : 1, alpha: 1)
    if #available(macOS 12.0, *) { web.underPageBackgroundColor = background }
    window = EditorWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1280, height: 860),
      styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
      backing: .buffered, defer: false)
    window.backgroundColor = background
    window.delegate = self
    window.minSize = NSSize(width: 640, height: 435)
    window.title = "Samare"
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.titlebarSeparatorStyle = .none
    window.isMovableByWindowBackground = false
    window.isReleasedWhenClosed = false
    window.contentView = web
    window.center()
    if defaults != nil { window.setFrameAutosaveName("SamareMain") }
    window.alphaValue = 0
    window.makeKeyAndOrderFront(nil)
    window.configureWindowedControls()
    NSApp.activate(ignoringOtherApps: true)
    guard let page = Bundle.main.url(forResource: "index", withExtension: "html") else {
      fail("The interface is missing from the application bundle.")
      return
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.14) { [weak self] in
      guard let self, !self.didPresentInterface else { return }
      let cover = StartupMark(frame: self.web.bounds, background: background)
      self.web.addSubview(cover, positioned: .above, relativeTo: nil)
      self.launchCover = cover
      self.window.alphaValue = 1
    }
    web.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
    for link in deepLinks { openBridgeLink(link) }
    if isolatedHome == nil {
      observeSystemWake()
      #if canImport(Sparkle)
      updates.publish = { [weak self] state in self?.emit("updateState", state) }
      updates.start()
      #endif
      bridge(["app-open"]) { result in
        if case .failure(let issue) = result {
          NSLog("Bridge startup: %@", issue.localizedDescription)
        }
      }
    }
    watcher = Timer.scheduledTimer(withTimeInterval: 1.1, repeats: true) { [weak self] _ in
      self?.checkFiles()
    }
  }

  func observeSystemWake() {
    NSWorkspace.shared.notificationCenter.addObserver(
      self, selector: #selector(wokeFromSleep), name: NSWorkspace.didWakeNotification, object: nil)
  }

  @objc func wokeFromSleep() {
    bridge(["app-open"]) { _ in self.bridgeStatus() }
    #if canImport(Sparkle)
    updates.check(interactive: false)
    #endif
  }

  func applicationDidBecomeActive(_ notification: Notification) {
    if isReady { checkFiles() }
    #if canImport(Sparkle)
    if isReady && isolatedHome == nil { updates.check(interactive: false) }
    #endif
  }

  func application(_ application: NSApplication, open urls: [URL]) {
    if window == nil {
      queued += urls
      return
    }
    for url in urls {
      if url.isFileURL {
        do { try open(url) } catch { fail(error.localizedDescription) }
      } else {
        openBridgeLink(url)
      }
    }
    window.makeKeyAndOrderFront(nil)
  }

  func application(_ sender: NSApplication, openFiles filenames: [String]) {
    let urls = filenames.map { URL(fileURLWithPath: $0) }
    if window == nil {
      queued += urls
    } else {
      for url in urls { do { try open(url) } catch { fail(error.localizedDescription) } }
      window.makeKeyAndOrderFront(nil)
    }
    sender.reply(toOpenOrPrint: .success)
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool
  {
    window?.makeKeyAndOrderFront(nil)
    return true
  }
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
  func applicationWillTerminate(_ notification: Notification) {
    persist()
    #if canImport(Sparkle)
    updates.stop()
    #endif
    let home = isolatedHome
    if let home, !FileManager.default.fileExists(atPath: home.path) { return }
    if let executable = Bundle.main.resourceURL?.appendingPathComponent(
      "Bridge/samare"), FileManager.default.isExecutableFile(atPath: executable.path)
    {
      let process = Process()
      process.executableURL = executable
      process.arguments = [home == nil ? "app-close" : "stop"]
      process.environment = bridgeEnvironment()
      process.standardOutput = FileHandle.nullDevice
      process.standardError = FileHandle.nullDevice
      if (try? process.run()) != nil { process.waitUntilExit() }
    }
    if let home { try? FileManager.default.removeItem(at: home) }
  }

  func restore() {
    guard let prefs = defaults else { return }
    settings = prefs.dictionary(forKey: "settings") ?? [:]
    for item in prefs.stringArray(forKey: "folders") ?? [] {
      _ = try? store.grantFolder(DocumentStore.canonical(item))
    }
    for item in prefs.stringArray(forKey: "tabs") ?? []
    where FileManager.default.fileExists(atPath: item) {
      if let url = try? store.grantFile(DocumentStore.canonical(item)) { tabs.append(url.path) }
    }
    for item in prefs.stringArray(forKey: "recent") ?? []
    where FileManager.default.fileExists(atPath: item) {
      _ = try? store.grantFile(DocumentStore.canonical(item))
    }
    activePath = prefs.string(forKey: "activePath") ?? ""
    if !tabs.contains(activePath) { activePath = tabs.first ?? "" }
    activeWorkspace = prefs.string(forKey: "activeWorkspace") ?? ""
    if !store.folders.contains(where: { $0.path == activeWorkspace }) {
      activeWorkspace = store.folders.first?.path ?? ""
    }
  }

  func persist() {
    defaults?.set(settings, forKey: "settings")
    defaults?.set(store.folders.map(\.path), forKey: "folders")
    defaults?.set(tabs, forKey: "tabs")
    defaults?.set(activePath, forKey: "activePath")
    defaults?.set(activeWorkspace, forKey: "activeWorkspace")
  }

  var folderRecords: [[String: String]] {
    store.folders.map { ["name": $0.lastPathComponent, "path": $0.path] }
  }
  func foldersChanged() {
    persist()
    emit("workspaces", ["workspaces": folderRecords, "activeWorkspace": activeWorkspace])
    if !activeWorkspace.isEmpty { emit("activeWorkspace", ["path": activeWorkspace]) }
  }

  func bootstrap() {
    let files = tabs.compactMap { path -> [String: Any]? in
      guard let url = try? store.file(path), let text = try? store.read(url) else { return nil }
      track(url, text)
      return ["path": path, "name": url.lastPathComponent, "text": text, "modified": modified(url)]
    }
    emit(
      "bootstrap",
      [
        "version": releaseVersion, "showRelease": pendingRelease, "workspaces": folderRecords, "activeWorkspace": activeWorkspace,
        "files": files, "activePath": activePath, "settings": settings,
        "nativeFullscreen": window?.styleMask.contains(.fullScreen) ?? false,
      ])
  }

  func open(_ rawURL: URL) throws {
    let url = DocumentStore.canonical(rawURL.path)
    if DocumentStore.isDirectory(url) {
      activeWorkspace = try store.grantFolder(url).path
      foldersChanged()
      return
    }
    let file = try store.grantFile(url)
    try publish(file)
  }

  func publish(_ file: URL, previous: String? = nil) throws {
    let text = try store.read(file)
    _ = try store.grantFile(file)
    track(file, text)
    if let previous { tabs.removeAll { $0 == previous } }
    if !tabs.contains(file.path) { tabs.append(file.path) }
    activePath = file.path
    let previousWorkspace = activeWorkspace
    if let folder = store.folders.filter({ DocumentStore.contains($0, file) }).max(by: {
      $0.path.count < $1.path.count
    }) {
      activeWorkspace = folder.path
    }
    var payload: [String: Any] = [
      "path": file.path, "name": file.lastPathComponent, "text": text, "modified": modified(file),
    ]
    if let previous { payload["previousPath"] = previous }
    remember(file)
    persist()
    if activeWorkspace != previousWorkspace { emit("activeWorkspace", ["path": activeWorkspace]) }
    emit("document", payload)
  }

  func modified(_ url: URL) -> Double {
    (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate?
      .timeIntervalSince1970) ?? 0
  }
  func track(_ url: URL, _ text: String) {
    lastSeen[url.path] = text
    signatures[url.path] = signature(url.path)
    missing.remove(url.path)
  }
  private func signature(_ path: String) -> String? {
    guard let info = try? FileManager.default.attributesOfItem(atPath: path) else { return nil }
    return
      "\(info[.systemFileNumber] ?? 0)|\(info[.size] ?? 0)|\((info[.modificationDate] as? Date)?.timeIntervalSinceReferenceDate ?? 0)"
  }
  func checkFiles() {
    guard isReady else { return }
    for (path, previous) in watchedFolders {
      let folder = DocumentStore.canonical(path)
      guard store.folders.contains(where: { DocumentStore.contains($0, folder) }),
        let current = signature(path)
      else {
        watchedFolders.removeValue(forKey: path)
        continue
      }
      if current != previous, let entries = try? store.listing(folder) {
        watchedFolders[path] = current
        emit("listing", ["path": path, "entries": entries])
      }
    }
    for path in tabs {
      guard let sig = signature(path) else {
        if missing.insert(path).inserted { emit("missing", ["path": path]) }
        continue
      }
      if signatures[path] == sig && !missing.contains(path) { continue }
      guard let url = try? store.file(path), let text = try? store.read(url) else { continue }
      let changed = lastSeen[path] != text || missing.contains(path)
      track(url, text)
      if changed {
        emit(
          "externalChange",
          ["path": path, "name": url.lastPathComponent, "text": text, "modified": modified(url)])
      } else {
        emit("fileMetadata", ["path": path, "modified": modified(url)])
      }
    }
  }

  func remember(_ url: URL) {
    guard let prefs = defaults else { return }
    var recent = prefs.stringArray(forKey: "recent") ?? []
    recent.removeAll { $0 == url.path }
    recent.insert(url.path, at: 0)
    prefs.set(Array(recent.prefix(24)), forKey: "recent")
    rebuildRecent()
  }

  func emit(_ type: String, _ value: Any) {
    guard isReady else { return }
    web.callAsyncJavaScript(
      "if (typeof window.hostEvent === 'function') window.hostEvent(kind, payload);",
      arguments: ["kind": type, "payload": value], in: nil, in: .page
    ) { result in
      if case .failure(let error) = result {
        NSLog("Interface event %@: %@", type, error.localizedDescription)
      }
    }
  }
  func fail(_ text: String) {
    if isReady {
      emit("error", text)
    } else {
      let alert = NSAlert()
      alert.messageText = text
      alert.runModal()
    }
  }

  func userContentController(
    _ userContentController: WKUserContentController, didReceive message: WKScriptMessage
  ) {
    guard message.frameInfo.isMainFrame, message.frameInfo.request.url?.isFileURL == true,
      let data = message.body as? [String: Any], let type = data["type"] as? String
    else { return }
    let path = data["path"] as? String ?? ""
    let text = data["text"] as? String ?? ""
    do {
      switch type {
      case "ready":
        trashSelections.removeAll()
        isReady = true
        bootstrap()
        scheduleCapture()
      case "firstPaint":
        didPresentInterface = true
        launchCover?.removeFromSuperview()
        launchCover = nil
        window?.alphaValue = 1
        window?.makeKeyAndOrderFront(nil)
        window?.configureWindowedControls()
        #if canImport(Sparkle)
        emit("updateState", updates.state)
        #endif
      case "releasePresented":
        if let version = data["version"] as? String, version == releaseVersion && pendingRelease {
          pendingRelease = false
          ReleaseHistory.acknowledge(build: releaseBuild, version: version, defaults: defaults)
        }
      case "checkUpdates", "installUpdate":
        #if canImport(Sparkle)
        if isolatedHome == nil {
          if type == "installUpdate" { updates.install() } else { updates.check(interactive: true) }
        }
        #endif
      case "exitFullScreen":
        if window.styleMask.contains(.fullScreen) { window.toggleFullScreen(nil) }
      case "openFiles": choose(false)
      case "openFolder": choose(true)
      case "chooseWorkspace":
        if path.isEmpty {
          choose(true)
        } else if store.folders.contains(where: { $0.path == path }) {
          activeWorkspace = path
          foldersChanged()
        }
      case "closeWorkspace":
        store.closeFolder(DocumentStore.canonical(path))
        if activeWorkspace == path { activeWorkspace = store.folders.first?.path ?? "" }
        foldersChanged()
      case "listFolder":
        let folder = DocumentStore.canonical(path)
        emit("listing", ["path": folder.path, "entries": try store.listing(folder)])
        watchedFolders[folder.path] = signature(folder.path)
      case "searchFiles": search(data)
      case "read": try publish(store.file(path))
      case "save":
        guard let base = data["baseText"] as? String, let contents = data["text"] as? String else {
          throw HostError("Reload this file before saving.")
        }
        let file = try store.file(path)
        switch try store.write(contents, to: file, replacing: base) {
        case .saved:
          track(file, contents)
          emit("saved", ["path": file.path, "text": contents, "modified": modified(file)])
        case .conflict(let disk):
          track(file, disk)
          emit("conflict", ["path": file.path, "text": disk])
        }
      case "saveAs", "newFile": saveAs(data, new: type == "newFile")
      case "createFolder": try createFolder(data)
      case "rename": try rename(data)
      case "move": try move(data)
      case "restoreFile": try restoreFile(path, text)
      case "flushed":
        if let id = data["id"] as? String {
          finishedFlush(id: id, ok: data["ok"] as? Bool ?? false)
        }
      case "defaultStatus":
        if data["reset"] as? Bool == true { defaultChangeError = nil }
        defaultStatus()
      case "setDefault": chooseDefault()
      case "trash": try trash(path)
      case "stageTrash": stageTrash(data)
      case "cancelTrash": if let id = data["id"] as? String { trashSelections.removeValue(forKey: id) }
      case "trashBatch": trashBatch(data)
      case "reveal":
        let url = try grantedItem(path)
        NSWorkspace.shared.activateFileViewerSelecting([url])
      case "copy":
        NSPasteboard.general.clearContents()
        let copied = NSPasteboard.general.setString(text, forType: .string)
        if let request = data["requestId"] {
          emit("copyResult", ["requestId": request, "ok": copied])
        }
      case "exportPDF", "exportHTML", "print": export(type, data)
      case "agentLink":
        let file = try store.file(path)
        let folder = store.folders.filter { DocumentStore.contains($0, file) }.max {
          $0.path.count < $1.path.count
        }
        let command =
          folder.map { ["url", "--asset-root", $0.path, file.path] } ?? ["url", file.path]
        bridge(command) { result in
          do {
            let url = try result.get()
            self.emit("agentLink", ["path": file.path, "url": url])
          } catch let error as BridgeSetupRequired {
            self.emit("agentSetupRequired", ["path": file.path, "message": error.localizedDescription])
          } catch { self.fail(error.localizedDescription) }
        }
      case "bridgeStatus": bridgeStatus()
      case "bridgeRepair": changeBridge(["repair"])
      case "bridgeCommand":
        if let enabled = data["enabled"] as? Bool {
          changeBridge([enabled ? "install-command" : "remove-command"])
        }
      case "bridgeClient":
        if let name = data["client"] as? String, ["codex", "claude", "cursor"].contains(name),
          let enabled = data["enabled"] as? Bool
        {
          changeBridge([enabled ? "install-skill" : "remove-skill", name])
        }
      case "bridgeBackground", "bridgeAuto":
        if let enabled = data["enabled"] as? Bool {
          changeBridge(["background", enabled ? "enable" : "disable"])
        }
      case "toggleBridge", "bridgeEnabled":
        if let enabled = data["enabled"] as? Bool {
          changeBridge([enabled ? "enable" : "disable"])
        }
      case "openExternal":
        guard let url = URL(string: data["url"] as? String ?? ""),
          ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "")
        else { throw HostError("Unsupported link.") }
        NSWorkspace.shared.open(url)
      case "preferences":
        if let values = data["settings"] as? [String: Any],
          PropertyListSerialization.propertyList(values, isValidFor: .binary)
        {
          settings = values
          persist()
        }
      case "recentTabs":
        if let paths = data["paths"] as? [String] {
          tabs = paths.filter { (try? store.file($0)) != nil }
          activePath = data["activePath"] as? String ?? ""
          persist()
        }
      case "dragWindow":
        if let event = NSApp.currentEvent,
          event.type == .leftMouseDown || event.type == .leftMouseDragged
        {
          window.performDrag(with: event)
        }
      case "toggleZoom": window.performZoom(nil)
      case "action": if let command = data["command"] as? String { emit("command", command) }
      default: break
      }
    } catch {
      if type == "save" || type == "restoreFile" {
        emit("saveError", ["path": path, "message": error.localizedDescription])
      } else {
        fail(error.localizedDescription)
      }
    }
  }

  func choose(_ folder: Bool) {
    let panel = NSOpenPanel()
    panel.canChooseFiles = !folder
    panel.canChooseDirectories = folder
    panel.allowsMultipleSelection = true
    panel.prompt = folder ? "Add Workspace" : "Open"
    if !folder {
      panel.allowedContentTypes = DocumentStore.extensions.sorted().compactMap {
        UTType(filenameExtension: $0)
      }
    }
    panel.beginSheetModal(for: window) { [weak self] result in
      guard result == .OK, let self else { return }
      for url in panel.urls {
        do { try self.open(url) } catch { self.fail(error.localizedDescription) }
      }
    }
  }

  func webView(
    _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    guard let url = action.request.url else {
      decisionHandler(.cancel)
      return
    }
    if url.isFileURL,
      url.standardizedFileURL.path
        == Bundle.main.url(forResource: "index", withExtension: "html")?.standardizedFileURL.path
    {
      decisionHandler(.allow)
      return
    }
    if action.navigationType == .linkActivated,
      ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "")
    {
      NSWorkspace.shared.open(url)
    }
    decisionHandler(.cancel)
  }

  func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
    do {
      guard let url = task.request.url else { throw HostError("Invalid relative image.") }
      let (data, mime) = try store.image(at: url)
      task.didReceive(
        URLResponse(
          url: url, mimeType: mime, expectedContentLength: data.count, textEncodingName: nil))
      task.didReceive(data)
      task.didFinish()
    } catch { task.didFailWithError(error) }
  }
  func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

  func scheduleCapture() {
    guard let i = args.firstIndex(of: "--capture"), args.indices.contains(i + 1) else { return }
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
      self.web.takeSnapshot(with: nil) { image, error in
        if let data = image?.tiffRepresentation, let rep = NSBitmapImageRep(data: data),
          let png = rep.representation(using: .png, properties: [:])
        {
          try? png.write(to: URL(fileURLWithPath: self.args[i + 1]))
        } else if let error {
          NSLog("%@", error.localizedDescription)
        }
        if self.args.contains("--quit-after-capture") { NSApp.terminate(nil) }
      }
    }
  }
}
