import AppKit
import PDFKit
import WebKit

let args = CommandLine.arguments
if args.count == 4 && args[1] == "--drive", let pid = Int32(args[2]) {
  do { try SaveSheet.drive(pid: pid, reopening: args[3] == "reopen"); exit(0) }
  catch { fputs(error.localizedDescription + "\n",stderr); exit(1) }
}

let app = NSApplication.shared
let previousApplication = NSWorkspace.shared.frontmostApplication
defer {
  if NSWorkspace.shared.frontmostApplication?.processIdentifier == getpid() {
    previousApplication?.activate(options:[])
  }
}
app.setActivationPolicy(.regular)
app.finishLaunching()
let fm = FileManager.default
let root = fm.temporaryDirectory.appendingPathComponent("SamarePrintPanel-" + UUID().uuidString)
let first = root.appendingPathComponent("First"), second = first.appendingPathComponent("Second")
try fm.createDirectory(at:first,withIntermediateDirectories:true)
let suite = "io.github.digidai.samare.print.panel." + UUID().uuidString
let prefs = UserDefaults(suiteName:suite)!
defer { try? fm.removeItem(at:root); prefs.removePersistentDomain(forName:suite) }
let host = SamareHost()
host.defaults = prefs
let cfg = WKWebViewConfiguration()
cfg.websiteDataStore = .nonPersistent()
cfg.userContentController.add(host,name:"host")
cfg.setURLSchemeHandler(host,forURLScheme:"samareasset")
let web = WKWebView(frame:NSRect(x:0,y:0,width:840,height:640),configuration:cfg)
host.web = web
host.window = EditorWindow(contentRect:web.bounds,styleMask:[.titled,.closable],backing:.buffered,defer:false)
host.window.title = "Samare PDF export test"
host.window.contentView = web
host.window.makeKeyAndOrderFront(nil)
host.makeMenus()
NSApp.activate(ignoringOtherApps:true)

func require(_ condition: Bool, _ detail: String) throws {
  if !condition { throw HostError(detail) }
}

func wait(_ description: String, timeout: Double = 20, until check: () -> Bool) throws {
  let deadline = Date().addingTimeInterval(timeout)
  while !check() {
    if Date() > deadline { throw HostError("Timed out waiting for " + description) }
    let tick = Date().addingTimeInterval(0.02)
    if let e = NSApp.nextEvent(matching:.any,until:tick,inMode:.default,dequeue:true) { NSApp.sendEvent(e) }
    RunLoop.current.run(until:tick)
  }
}

func chooseExport() throws -> NSSavePanel {
  guard let menu = NSApp.mainMenu?.items.compactMap(\.submenu).first(where:{ $0.title == "File" }),
        let index = menu.items.firstIndex(where:{ $0.representedObject as? String == "exportPDF" })
  else { throw HostError("File > Export PDF menu item is missing.") }
  menu.performActionForItem(at:index)
  try wait("native save sheet") { host.window.attachedSheet is NSSavePanel }
  return host.window.attachedSheet as! NSSavePanel
}

func drive(_ phase: String) throws {
  let child = Process()
  child.executableURL = URL(fileURLWithPath:args[0])
  child.arguments = ["--drive",String(getpid()),phase]
  try child.run()
  defer { if child.isRunning { child.terminate() } }
  try wait("save sheet controls",timeout:40) { !child.isRunning }
  try require(child.terminationStatus == 0,"The save sheet did not finish the requested UI action.")
}

func run() throws {
  let resources = URL(fileURLWithPath:fm.currentDirectoryPath).appendingPathComponent("Resources")
  let note = root.appendingPathComponent("Print sample.md"), exported = second.appendingPathComponent("Print sample.pdf")
  let link = "https://example.com/actual-export"
  let rows = (1...115).map { "| Record \($0) | Text |" }.joined(separator:"\n")
  let markdown = "# Export sample\n\n| Repeated heading | Name |\n| --- | --- |\n" + rows + "\n\n[Read more](\(link))\n"
  try Data(markdown.utf8).write(to:note)
  try host.open(note)
  web.loadFileURL(resources.appendingPathComponent("index.html"),allowingReadAccessTo:resources)
  try wait("editor and Markdown table") {
    var ready: Bool?
    web.evaluateJavaScript("!!document.querySelector('.ProseMirror table tbody tr th')") { result,_ in ready = result as? Bool ?? false }
    try? wait("WebKit",until:{ ready != nil })
    return ready == true
  }
  prefs.set(first.path,forKey:"lastPDFDirectory")
  _ = try chooseExport()
  try drive("export")
  try wait("PDF on disk") { fm.fileExists(atPath:exported.path) }
  guard let pdf = PDFDocument(url:exported) else { throw HostError("PDFKit could not read the exported document.") }
  let pages = (0..<pdf.pageCount).compactMap { pdf.page(at:$0) }
  let tables = pages.filter { $0.string?.contains("Record") == true }
  try require(tables.count >= 2,"The test table must span multiple PDF pages.")
  try require(tables.allSatisfy { $0.string?.contains("Repeated heading") == true },"A table page lost its header.")
  let contents = pages.compactMap(\.string).joined(separator:"\n") as NSString
  let pattern = try NSRegularExpression(pattern:"\\bRecord\\s+(\\d+)\\b")
  let ids = pattern.matches(in:contents as String,range:NSRange(location:0,length:contents.length))
    .compactMap { Int(contents.substring(with:$0.range(at:1))) }
  try require(ids == Array(1...115),"Some table records were lost, duplicated or reordered.")
  try require(pages.flatMap(\.annotations).contains { $0.url?.absoluteString == link },"Missing clickable URL in PDF.")
  try require(pages.first?.string?.contains("Export sample") == true &&
    pages.last?.string?.contains("Read more") == true,"The beginning or end of the note is absent from the PDF.")
  try wait("recorded export directory") {
    guard let path = prefs.string(forKey:"lastPDFDirectory") else { return false }
    return URL(fileURLWithPath:path).resolvingSymlinksInPath().path == second.resolvingSymlinksInPath().path
  }
  _ = try chooseExport()
  try drive("reopen")
  print("File > Export PDF wrote all \(ids.count) rows across \(pdf.pageCount) pages, repeated the header on all \(tables.count) table pages, retained the clickable URL, and showed the last chosen directory when reopened.")
}

do { try run() }
catch {
  fputs(error.localizedDescription + "\n",stderr)
  try? fm.removeItem(at:root)
  prefs.removePersistentDomain(forName:suite)
  exit(1)
}
