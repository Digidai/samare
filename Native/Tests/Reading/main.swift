import AppKit
import WebKit

// Separate host processes exercise the real preferences, shell, editor and WebKit selection.
let args = CommandLine.arguments
let resources = URL(fileURLWithPath: args[1]).standardizedFileURL
let fm = FileManager.default
if !args.contains("--child") {
  let suite = "io.github.digidai.samare.reading-test." + UUID().uuidString
  let folder = fm.temporaryDirectory.appendingPathComponent(suite)
  try fm.createDirectory(at: folder, withIntermediateDirectories: true)
  defer {
    try? fm.removeItem(at: folder)
    UserDefaults.standard.removePersistentDomain(forName: suite)
  }
  let lines = (1...160).map { "Paragraph \($0) for reading position." }
  try lines.joined(separator: "\n\n").write(to: folder.appendingPathComponent("First.md"), atomically: true, encoding: .utf8)
  try lines.joined(separator: "\n").write(to: folder.appendingPathComponent("Second.txt"), atomically: true, encoding: .utf8)
  let gridText = (["ID,Name"] + (1...301).map { "\($0),Item \($0)" }).joined(separator:"\r\n")
  let tableURL = folder.appendingPathComponent("Table.csv")
  try gridText.write(to: tableURL, atomically: true, encoding: .utf8)
  for phase in ["write", "reopen", "shortened"] {
    if phase == "shortened" {
      try "Small".write(to: folder.appendingPathComponent("First.md"), atomically: true, encoding: .utf8)
    }
    let child = Process()
    child.executableURL = URL(fileURLWithPath: args[0]).standardizedFileURL
    child.arguments = [resources.path, "--isolated", "--child", phase, suite, folder.path]
    try child.run()
    child.waitUntilExit()
    if child.terminationStatus != 0 { fputs("Reading test failed in " + phase + "\n", stderr); exit(1) }
  }
  let savedGrid = try String(contentsOf: tableURL, encoding: .utf8)
  precondition(savedGrid == gridText)
  print("Reading session passed in three independent Mac processes: rich and source carets, CSV page and cell, per-tab progress, immediate quit and a shortened file")
} else {
  let phase = args[4], suite = args[5], folder = DocumentStore.canonical(args[6])
  let first = folder.appendingPathComponent("First.md").path
  let second = folder.appendingPathComponent("Second.txt").path
  let table = folder.appendingPathComponent("Table.csv").path
  let app = NSApplication.shared
  app.setActivationPolicy(.prohibited)
  final class ReadingHost: SamareHost {
    var flushed = false
    override func fail(_ text: String) { fatalError(text) }
    override func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
      super.userContentController(controller, didReceive: message)
      if let data = message.body as? [String: Any], data["type"] as? String == "flushed" {
        flushed = data["ok"] as? Bool == true
      }
    }
  }
  func wait(_ title: String, _ check: () -> Bool) {
    let deadline = Date().addingTimeInterval(12)
    while !check() {
      precondition(Date() < deadline, title)
      RunLoop.current.run(until: Date().addingTimeInterval(0.025))
    }
  }
  let host = ReadingHost()
  host.defaults = UserDefaults(suiteName: suite)
  if phase == "write" {
    try host.open(folder)
    try host.open(URL(fileURLWithPath: table))
    try host.open(URL(fileURLWithPath: second))
    try host.open(URL(fileURLWithPath: first))
  } else {
    host.restore()
    precondition(host.activePath == (phase == "reopen" ? second : first))
    precondition(host.tabs.count == 3)
  }
  let config = WKWebViewConfiguration()
  config.websiteDataStore = .nonPersistent()
  config.userContentController.add(host, name: "host")
  config.setURLSchemeHandler(host, forURLScheme: "samareasset")
  let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1040, height: 760), configuration: config)
  host.web = web
  host.window = EditorWindow(contentRect: web.bounds, styleMask: [.borderless], backing: .buffered, defer: false)
  host.window.contentView = web
  host.window.isExcludedFromWindowsMenu = true
  host.window.orderBack(nil)
  web.loadFileURL(resources.appendingPathComponent("index.html"), allowingReadAccessTo: resources)
  func js(_ code: String) -> Any? {
    var result: Any?, done = false
    web.evaluateJavaScript(code) { value, error in
      precondition(error == nil, error?.localizedDescription ?? "")
      result = value
      done = true
    }
    wait("WebKit evaluation") { done }
    return result
  }
  func assertJS(_ script: String) {
    let deadline = Date().addingTimeInterval(10)
    while js(script) as? Bool != true {
      if Date() > deadline {
        let describe = "JSON.stringify({top:document.querySelector('#scroll').scrollTop, max:document.querySelector('#scroll').scrollHeight, focus:document.activeElement.className, progress:document.querySelector('#reading-progress').style.cssText, anchor:getSelection()?.anchorNode?.textContent?.slice(0,60), offset:getSelection()?.anchorOffset, source:document.querySelector('textarea.de-source')?.selectionStart, visibility:document.visibilityState})"
        fputs(script + " " + String(describing: js(describe)) + "\n", stderr)
        exit(1)
      }
      RunLoop.current.run(until: Date().addingTimeInterval(0.025))
    }
  }
  func flush() {
    host.emit("flush", ["id": "reading-test", "reason": "quit"])
    wait("quit acknowledgment") { host.flushed }
    precondition(host.defaults!.synchronize())
  }
  func reading(_ path: String) -> [String:Any] {
    let views = host.settings["views"] as? [String: [String: Any]]
    return views?[path]?["reading"] as? [String:Any] ?? [:]
  }
  let rich = "document.querySelector('.ProseMirror')"
  let source = "document.querySelector('textarea.de-source')"
  let top = "document.getElementById('scroll').scrollTop"
  let meter = "Number(document.getElementById('reading-progress').style.getPropertyValue('--read'))"
  let targetCell = "document.querySelector('[aria-label=\"Row 291, Name\"]')"
  assertJS("document.querySelectorAll('[role=tab]').length===3 && document.querySelector('.de-root')!==null")
  if phase == "write" {
    assertJS("\(rich)?.querySelectorAll('p').length===160")
    // Wait until this hidden window has laid out its initial reading position.
    assertJS("\(meter)===0 && document.querySelector('#scroll').scrollHeight>1600")
    _ = js("""
      (() => { let el=\(rich); el.focus(); let p=el.querySelectorAll('p')[64].firstChild;
        let r=document.createRange(); r.setStart(p,8); r.collapse(true);
        let s=getSelection(); s.removeAllRanges(); s.addRange(r);
        \(top)=1240; return true; })()
      """)
    assertJS("\(meter)>0")
    try host.publish(URL(fileURLWithPath: table))
    assertJS("document.querySelector('[aria-label=\"Next page\"]')!==null")
    _ = js("document.querySelector('[aria-label=\"Next page\"]').click()")
    assertJS("\(targetCell)!==null")
    _ = js("(()=>{const field=\(targetCell); field.focus(); field.setSelectionRange(2,4); return true})()")
    try host.publish(URL(fileURLWithPath: second))
    assertJS("\(source)!==null && \(top)===0")
    _ = js("(()=>{let t=\(source); t.focus(); t.setSelectionRange(488,488); \(top)=614;return true})()")
    flush()
    precondition(reading(first)["scroll"] as? Int == 1240, "rich scroll did not persist")
    precondition(reading(second)["cursor"] as? Int == 488, "source caret did not persist")
  } else if phase == "reopen" {
    assertJS("\(source)?.selectionStart===488 && \(top)===614 && \(meter)>0")
    try host.publish(URL(fileURLWithPath: table))
    assertJS("\(targetCell)!==null && document.activeElement===\(targetCell) && \(targetCell).selectionStart===2 && \(targetCell).selectionEnd===4")
    try host.publish(URL(fileURLWithPath: first))
    assertJS("getSelection()?.anchorNode?.textContent==='Paragraph 65 for reading position.' && getSelection().anchorOffset===8 && \(top)===1240 && \(meter)>0")
    flush()
  } else {
    assertJS("\(rich)?.textContent==='Small' && getSelection().anchorOffset===5 && \(top)===0 && \(meter)===0")
    flush()
  }
}
