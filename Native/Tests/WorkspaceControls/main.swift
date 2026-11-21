import AppKit
import WebKit

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let args = CommandLine.arguments
let resources = URL(fileURLWithPath: args[1]).standardizedFileURL
let fm = FileManager.default
let name = "A workspace with a very long Chinese and English name 远方的档案夹 for sidebar truncation"
let aDocs = ["A.md", "B.csv", "C.tsv", "D.json", "E.jsonl", "F.txt", "G.ndjson", "H.markdown"]
let samples = [
  "# A\n\n```mermaid\nflowchart LR\nA-->B\n```", "Name,Value\nAlpha,1\n", "Name\tValue\nOne\tTwo\n",
  "{\"field\":2}", "{\"message\":\"Hello\"}\n", "Words", "{\"n\":1}\n", "# H",
]
func stop(_ reason: String) -> Never {
  fputs("Workspace controls: \(reason)\n", stderr)
  exit(1)
}
if args.count < 6 {
  let folder = DocumentStore.canonical(
    fm.temporaryDirectory.appendingPathComponent("Controls-" + UUID().uuidString).path)
  let suite = "io.github.digidai.samare.controls." + UUID().uuidString
  defer {
    try? fm.removeItem(at: folder)
    UserDefaults.standard.removePersistentDomain(forName: suite)
  }
  let a = folder.appendingPathComponent(name)
  let b = folder.appendingPathComponent("Beta")
  try fm.createDirectory(at: a.appendingPathComponent("Sub"), withIntermediateDirectories: true)
  try fm.createDirectory(at: b, withIntermediateDirectories: true)
  for (i, filename) in aDocs.enumerated() {
    try samples[i].write(to: a.appendingPathComponent(filename), atomically: true, encoding: .utf8)
  }
  for (i, file) in ["Newest.md", "Oldest.md", "Middle.md"].enumerated() {
    let url = b.appendingPathComponent(file)
    try file.write(to: url, atomically: true, encoding: .utf8)
    try fm.setAttributes(
      [.modificationDate: Date(timeIntervalSince1970: [3000, 1000, 2000][i])],
      ofItemAtPath: url.path)
  }
  for phase in ["write", "restore"] {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: args[0]).standardizedFileURL
    process.arguments = [resources.path, "--isolated", phase, folder.path, suite]
    try process.run()
    process.waitUntilExit()
    if process.terminationStatus != 0 { exit(process.terminationStatus) }
  }
  print(
    "PASS: native menus and disk refresh, type labels and glyphs, independent workspace sort and per-file zoom persisted across two Mac processes."
  )
  exit(0)
}
let phase = args[3]
let folder = DocumentStore.canonical(args[4])
let a = folder.appendingPathComponent(name)
let b = folder.appendingPathComponent("Beta")
let host = SamareHost()
host.defaults = UserDefaults(suiteName: args[5])
if phase == "write" {
  try host.open(b)
  try host.open(a)
  for file in ["A.md", "B.csv", "C.tsv", "D.json", "E.jsonl"] {
    try host.open(a.appendingPathComponent(file))
  }
  try host.open(a.appendingPathComponent("A.md"))
} else {
  host.restore()
}
let config = WKWebViewConfiguration()
config.websiteDataStore = .nonPersistent()
config.userContentController.add(host, name: "host")
config.setURLSchemeHandler(host, forURLScheme: "samareasset")
let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1180, height: 860), configuration: config)
host.web = web
host.window = EditorWindow(
  contentRect: web.bounds, styleMask: [.borderless], backing: .buffered, defer: false)
host.window.contentView = web
host.window.isExcludedFromWindowsMenu = true
host.window.orderBack(nil)
host.makeMenus()
web.loadFileURL(resources.appendingPathComponent("index.html"), allowingReadAccessTo: resources)
func wait(_ why: String, _ fn: () -> Bool) {
  let until = Date().addingTimeInterval(10)
  while !fn() {
    if Date() > until { stop(why) }
    RunLoop.current.run(until: Date().addingTimeInterval(0.035))
  }
}
@discardableResult func js(_ script: String) -> Any? {
  var done = false
  var output: Any?
  web.evaluateJavaScript(script) { result, error in
    if let error { stop(script + " " + error.localizedDescription) }
    output = result
    done = true
  }
  wait("JS") { done }
  return output
}
func awaitJS(_ script: String) { wait(script) { js(script) as? Bool == true } }
func menu(_ label: String) {
  guard let group = NSApp.mainMenu?.items.compactMap(\.submenu).first(where: { $0.title == "View" })
  else { stop("View missing") }
  let idx = group.indexOfItem(withTitle: label)
  guard idx >= 0 else { stop(label) }
  group.performActionForItem(at: idx)
}
func go(_ file: String) {
  js("[...document.querySelectorAll('[role=tab]')].find(n=>n.title.endsWith('/\(file)')).click()")
  awaitJS("document.querySelector('[role=tab][aria-selected=true]').title.endsWith('/\(file)')")
}
func row(_ filename: String) -> String {
  "document.querySelector('[data-tree-path$=\"/\(filename)\"]')"
}
func group(_ target: String) {
  js(
    "[...document.querySelectorAll('.side-row')].find(n=>n.querySelector('.grow')?.textContent==='Back to workspaces').click()"
  )
  js(
    "[...document.querySelectorAll('.side-row')].find(n=>n.querySelector('.grow')?.textContent==='\(target)').click()"
  )
  awaitJS(
    "document.querySelector('.workspace-head .grow')?.textContent==='\(target)' && document.querySelectorAll('.file-row').length>1"
  )
}
let fileOrder = "[...document.querySelectorAll('.file-row .grow')].map(n=>n.textContent).join(',')"
func sort(_ title: String) {
  js(
    "document.querySelector('[aria-label=Sort]').click();[...document.querySelectorAll('#menu button')].find(n=>n.getAttribute('aria-label')==='\(title)').click()"
  )
}
let zoomFiles = [
  ("A.md", ".de-diagram svg", 1.4), ("B.csv", ".de-sheet td", 1.3), ("C.tsv", ".de-sheet td", 1.2),
  ("D.json", ".de-json-key", 1.1), ("E.jsonl", ".de-log-message", 0.8),
]
func rect(_ selector: String) -> Double {
  js("document.querySelector('\(selector)').getBoundingClientRect().height") as? Double ?? 0
}
awaitJS(
  "document.querySelectorAll('[role=tab]').length===5 && document.querySelector('.workspace-head')!==null"
)
if phase == "write" {
  group("Beta")
  sort("Last edited (new to old)")
  awaitJS(fileOrder + "==='Newest,Middle,Oldest'")
  sort("Last edited (old to new)")
  awaitJS(fileOrder + "==='Oldest,Middle,Newest'")
  group(name)
  sort("Name (Z to A)")
  awaitJS(fileOrder + ".startsWith('Sub,H,G.ndjson,F.txt,E.jsonl')")
  for (label, addition) in [("sidebar", "New1.txt"), ("View", "New2.txt")] {
    try "Added by test".write(
      to: a.appendingPathComponent(addition), atomically: true, encoding: .utf8)
    awaitJS(row(addition) + "===null")
    if label == "View" {
      menu("Refresh Files")
    } else {
      js("document.querySelector('.workspace-head [aria-label=Refresh]').click()")
    }
    awaitJS(row(addition) + "!==null")
  }
  let types =
    Array(
      zip(
        aDocs, ["file-text", "table", "table", "braces", "list", "file-text", "list", "file-text"]))
    + [("Sub", "folder")]
  var positions = [Double]()
  for (filename, glyph) in types {
    let r = row(filename)
    let ext = URL(fileURLWithPath: filename).pathExtension
    let expected = ["md", "markdown", ""].contains(ext) ? "" : "." + ext
    awaitJS("(\(r)?.querySelector('.ext')?.textContent||'')==='\(expected)'")
    awaitJS(
      "(()=>{let svg=\(r)?.querySelector('svg');let def=window.samareIcons['\(glyph)']; return !!svg && svg.children.length===def.length&&def.every(([t,a],i)=>svg.children[i].localName===t&&Object.entries(a).every(([k,v])=>k==='key'||svg.children[i].getAttribute(k)===String(v)));})()"
    )
    positions.append(
      js("\(r).querySelector('.grow').getBoundingClientRect().left") as? Double ?? -1)
  }
  if positions.max()! - positions.min()! > 1 { stop("file label misalignment \(positions)") }
  js("\(row("Sub")).click()")
  awaitJS(
    "\(row("Sub")).querySelector('svg').children[0].getAttribute('d') === window.samareIcons['folder-open'][0][1].d"
  )
  menu("Focus Mode")
  awaitJS("document.querySelector('#tabs').getClientRects().length===0")
  menu("Focus Mode")
  awaitJS("document.querySelector('#tabs').getClientRects().length>0")
  for (f, selector, scale) in zoomFiles {
    go(f)
    awaitJS("document.querySelector('\(selector)')?.getBoundingClientRect().height>0")
    let start = rect(selector)
    let sidebar = rect("#side-toggle")
    let tab = rect(".tab")
    for _ in 0..<Int(round(abs(scale - 1) * 10)) { menu(scale > 1 ? "Zoom In" : "Zoom Out") }
    awaitJS("Math.abs(Number(document.querySelector('#column').style.zoom)-\(scale))<.01")
    let actual = rect(selector) / start
    if abs(scale - actual) > 0.075 { stop("\(f) content zoom \(actual) expected \(scale)") }
    if abs(sidebar - rect("#side-toggle")) > 0.1 || abs(tab - rect(".tab")) > 0.1 {
      stop("Chrome zoomed")
    }
    print("\(f): rendered content ratio \(actual)")
  }
  menu("Actual Size")
  awaitJS("Number(document.querySelector('#column').style.zoom)===1")
  menu("Zoom Out")
  menu("Zoom Out")
  awaitJS("Number(document.querySelector('#column').style.zoom)===0.8")
  wait("saved scales") {
    (host.settings["views"] as? [String: [String: Any]])?[
      a.appendingPathComponent("E.jsonl").path]?["zoom"] as? Double == 0.8
  }
  precondition(host.defaults!.synchronize())
} else {
  if host.activeWorkspace != a.path { group(name) }
  awaitJS(fileOrder + ".startsWith('Sub,New2.txt,New1.txt,H')")
  group("Beta")
  awaitJS(fileOrder + "==='Oldest,Middle,Newest'")
  group(name)
  for (f, selector, scale) in zoomFiles {
    go(f)
    awaitJS(
      "document.querySelector('\(selector)')!==null && Math.abs(Number(document.querySelector('#column').style.zoom)-\(scale))<.01"
    )
  }
}
