import AppKit
import WebKit

// Drive the application's Quit shortcut and read disk in a separate process after exit.
// A delayed second write makes an early termination reliably observable.
let args = CommandLine.arguments
let resources = URL(fileURLWithPath: args[1]).standardizedFileURL
let fm = FileManager.default
func runParent() throws {
  let temp = fm.temporaryDirectory.appendingPathComponent("Samare-QuitWindows-" + UUID().uuidString)
  try fm.createDirectory(at: temp, withIntermediateDirectories: true)
  defer { try? fm.removeItem(at: temp) }
  for mode in ["delayed", "retry", "shared"] {
    let folder = temp.appendingPathComponent(mode)
    try fm.createDirectory(at: folder, withIntermediateDirectories: true)
    for name in mode == "shared" ? ["Shared"] : ["First", "Second"] {
      try Data(name.utf8).write(to: folder.appendingPathComponent(name + ".txt"))
    }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: args[0]).standardizedFileURL
    process.arguments = [resources.path, "--isolated", "--child", mode, folder.path]
    try process.run()
    process.waitUntilExit()
    precondition(process.terminationStatus == 0, mode)
    if mode == "shared" {
      let shared = try String(
        contentsOf: folder.appendingPathComponent("Shared.txt"), encoding: .utf8)
      for part in [
        "Shared by First", "Shared by Second", "<!-- samare:undecided yours:",
        "<!-- samare:undecided end -->",
      ] {
        precondition(shared.components(separatedBy: part).count == 2, shared)
      }
    } else {
      let first = try String(
        contentsOf: folder.appendingPathComponent("First.txt"), encoding: .utf8)
      let second = try String(
        contentsOf: folder.appendingPathComponent("Second.txt"), encoding: .utf8)
      precondition(
        first == "First last words"
          && second == (mode == "retry" ? "Second last words recovered" : "Second last words"))
    }
    let log = try String(contentsOf: folder.appendingPathComponent("events"), encoding: .utf8)
    let expected =
      mode == "retry"
      ? [
        "First saved", "Second refused", "application survived", "First saved", "Second saved",
        "will terminate",
      ]
      : ["First saved", "Second saved", "will terminate"]
    precondition(log.split(separator: "\n").map(String.init) == expected, log)
    print("\(mode): \(log.split(separator:"\n").joined(separator:" → ")); persisted text verified")
  }
}
if !args.contains("--child") {
  try runParent()
  exit(0)
}
let mode = args[4]
let folder = URL(fileURLWithPath: args[5])
func log(_ message: String) {
  let url = folder.appendingPathComponent("events")
  var data = (try? Data(contentsOf: url)) ?? Data()
  data.append(contentsOf: (message + "\n").utf8)
  try! data.write(to: url, options: .atomic)
}
func wait(_ label: String, _ check: () -> Bool) {
  let end = Date().addingTimeInterval(12)
  while !check() {
    precondition(Date() < end, label)
    RunLoop.current.run(until: Date().addingTimeInterval(0.02))
  }
}
class TestEditor: SamareHost {
  var name = "First"
  var note: URL { folder.appendingPathComponent((mode == "shared" ? "Shared" : name) + ".txt") }
  var second: TestEditor?
  func loadWindow() {
    try! open(note)
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent()
    config.userContentController.add(self, name: "host")
    config.setURLSchemeHandler(self, forURLScheme: "samareasset")
    web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1024, height: 740), configuration: config)
    window = EditorWindow(
      contentRect: web.bounds, styleMask: [.titled, .closable, .miniaturizable], backing: .buffered,
      defer: false)
    window.delegate = self
    window.contentView = web
    window.orderBack(nil)
    web.loadFileURL(resources.appendingPathComponent("index.html"), allowingReadAccessTo: resources)
  }
  func js(_ code: String) -> Bool {
    var value: Bool?
    web.evaluateJavaScript(code) { result, error in
      precondition(error == nil, error?.localizedDescription ?? "")
      value = result as? Bool ?? false
    }
    wait("WebKit evaluation") { value != nil }
    return value!
  }
  func type(_ suffix: String) {
    precondition(
      js(
        "(()=>{const t=document.querySelector('textarea.de-source');t.value+='\(suffix)';t.dispatchEvent(new Event('input',{bubbles:true}));return true})()"
      ))
  }
  func commandQ() {
    let key = NSEvent.keyEvent(
      with: .keyDown, location: .zero, modifierFlags: [.command],
      timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
      context: nil, characters: "q", charactersIgnoringModifiers: "q", isARepeat: false, keyCode: 12)!
    precondition(NSApp.mainMenu!.performKeyEquivalent(with: key))
  }
  override func applicationDidFinishLaunching(_ notification: Notification) {
    makeMenus()
    loadWindow()
    let other = TestEditor()
    second = other
    other.name = "Second"
    other.loadWindow()
    Timer.scheduledTimer(withTimeInterval: 0.04, repeats: false) { _ in
      for editor in [self, other] {
        wait("initial editor") { editor.js("!!document.querySelector('textarea.de-source')") }
      }
      if mode == "retry" {
        other.window.orderOut(nil)
        precondition(!other.window.isVisible && NSApp.windows.contains(other.window))
        try! fm.removeItem(at: other.note)
      } else {
        precondition(self.window.isVisible && other.window.isVisible)
      }
      self.type(mode == "shared" ? " by First" : " last words")
      other.type(mode == "shared" ? " by Second" : " last words")
      precondition(
        (try? String(contentsOf: self.note, encoding: .utf8))
          == (mode == "shared" ? "Shared" : "First"))
      self.commandQ()
    }
  }
  override func userContentController(
    _ controller: WKUserContentController, didReceive message: WKScriptMessage
  ) {
    guard let payload = message.body as? [String: Any] else { return }
    let kind = payload["type"] as? String
    if kind == "save", name == "Second" {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
        super.userContentController(controller, didReceive: message)
      }
      return
    }
    let refused = kind == "flushed" && payload["ok"] as? Bool == false
    if kind == "flushed" { log(name + (refused ? " refused" : " saved")) }
    super.userContentController(controller, didReceive: message)
    if refused && mode == "retry" {
      Timer.scheduledTimer(withTimeInterval: 0.15, repeats: false) { _ in
        precondition(
          self.js("document.querySelector('textarea.de-source').value==='Second last words'"))
        log("application survived")
        try! Data("Second".utf8).write(to: self.note)
        self.type(" recovered")
        self.commandQ()
      }
    }
  }
  override func applicationWillTerminate(_ notification: Notification) { log("will terminate") }
}
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let primary = TestEditor()
app.delegate = primary
DispatchQueue.main.asyncAfter(deadline: .now() + 25) {
  fputs("Timed out during system termination\n", stderr)
  exit(1)
}
app.run()
