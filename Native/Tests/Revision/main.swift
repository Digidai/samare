import AppKit
import WebKit

let resources = URL(fileURLWithPath: CommandLine.arguments[1]).standardizedFileURL
let folder = FileManager.default.temporaryDirectory.appendingPathComponent("SamareRevision-" + UUID().uuidString)
try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: folder) }
let file = folder.appendingPathComponent("Example.md")
let other = folder.appendingPathComponent("Other.md")
let initial = "# Trial\n\nFirst before.\n\nMiddle local.\n\nLast before.\n"
try initial.write(to: file, atomically: true, encoding: .utf8)
try "# Other".write(to: other, atomically: true, encoding: .utf8)
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let host = SamareHost()
try host.open(other)
try host.open(file)
let config = WKWebViewConfiguration()
config.websiteDataStore = .nonPersistent()
config.userContentController.add(host, name: "host")
config.setURLSchemeHandler(host, forURLScheme: "samareasset")
let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1080, height: 760), configuration: config)
host.web = web
host.window = EditorWindow(contentRect: web.bounds, styleMask: [.borderless], backing: .buffered, defer: false)
host.window.contentView = web
host.window.orderBack(nil)
func wait(_ label: String, _ check: () -> Bool) {
  let deadline = Date().addingTimeInterval(9)
  while !check() {
    if Date() > deadline { fputs("Revision test timed out: " + label + "\n", stderr); exit(1) }
    RunLoop.current.run(until: Date().addingTimeInterval(0.035))
  }
}
@discardableResult func js(_ code: String) -> Any? {
  var done = false, result: Any?
  web.evaluateJavaScript(code) { value, error in
    if let error { fputs("JavaScript: " + error.localizedDescription + " in " + code.prefix(160) + "\n", stderr); exit(1) }
    result = value; done = true
  }
  wait("WebKit evaluation") { done }
  return result
}
func shown(_ selector: String) {
  wait(selector) { js("!!document.querySelector('\(selector)')?.getClientRects().length") as? Bool == true }
}
func edit(_ paragraph: String, _ content: String, replace: Bool = false) {
  let script = """
  (() => {
    const n = [...document.querySelectorAll('.ProseMirror p')].find(n => n.textContent === '\(paragraph)');
    if (!n) return false;
    n.parentElement.focus();
    const r = document.createRange(); r.selectNodeContents(n);
    if (!\(replace)) r.collapse(false);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    return document.execCommand('insertText',false,'\(content)');
  })()
  """
  precondition(js(script) as? Bool == true, paragraph)
}
func onDisk(_ text: String) {
  wait("saved file") { (try? String(contentsOf: file, encoding:.utf8)) == text }
}
web.loadFileURL(resources.appendingPathComponent("index.html"), allowingReadAccessTo: resources)
shown(".ProseMirror p")
edit("Middle local.", " My edit.")
let remote = initial.replacingOccurrences(of:"before", with:"changed")
try remote.write(to:file, atomically:true, encoding:.utf8)
host.checkFiles()
shown("#merge-show")
js("document.querySelector('#merge-show').click()")
shown("#merge-card")
shown(".reader-change-active")
js("document.querySelector('#merge-card').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
edit("Middle local. My edit.", " Later.")
js("document.querySelector('.reader-change').click()")
js("document.querySelector('#merge-left').click()")
js("document.querySelector('#merge-right').click()")
let local = remote.replacingOccurrences(of:"First changed.",with:"First before.").replacingOccurrences(of:"Middle local.",with:"Middle local. My edit. Later.")
onDisk(local)
edit("Middle local. My edit. Later.","Mine again.",replace:true)
let incoming = local.replacingOccurrences(of:"Middle local. My edit. Later.",with:"Theirs again.")
try incoming.write(to:file, atomically:true, encoding:.utf8)
host.checkFiles()
shown("#keep-both")
edit("First before."," Kept.")
let partial = incoming.replacingOccurrences(of:"First before.",with:"First before. Kept.")
onDisk(partial)
js("document.querySelectorAll('[role=tab]')[0].click()")
wait("other tab") { js("document.querySelector('.ProseMirror h1')?.textContent === 'Other'") as? Bool == true }
js("document.querySelectorAll('[role=tab]')[1].click()")
shown("#keep-all")
// Ask the real shell to flush as it does for Close or Quit. Re-open without its local draft.
host.emit("flush", ["id":"revision-audit","reason":"quit"])
let marked = "<!-- samare:undecided yours: two versions of this part, not chosen yet. Yours first, then the new one. -->\n\nMine again.\n\n<!-- samare:undecided new -->\n\nTheirs again.\n\n<!-- samare:undecided end -->"
onDisk(partial.replacingOccurrences(of:"Theirs again.",with:marked))
js("localStorage.clear()")
web.reload()
shown("#keep-all")
precondition(js("document.querySelector('#merge-card').hidden") as? Bool == true)
js("document.querySelector('.reader-change').click()")
shown("#keep-both")
js("document.querySelector('#keep-both').click()")
let final = incoming.replacingOccurrences(of:"First before.",with:"First before. Kept.").replacingOccurrences(of:"Theirs again.",with:"Mine again.\n\nTheirs again.")
onDisk(final)
print("Mac WebKit and native disk writes passed automatic merge, individual restore, later edits, tab switching, reload and Keep both.")

// Use a separate note so this metadata check never introduces merge revisions in the fixture above.
js("document.querySelectorAll('[role=tab]')[0].click()")
wait("other tab for inspector") { js("document.querySelector('.ProseMirror h1')?.textContent === 'Other'") as? Bool == true }
js("document.getElementById('rail').click()")
func inspectTime(_ hoursAgo: Int) throws {
  try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(-Double(hoursAgo * 3600 + 5))], ofItemAtPath: other.path)
  host.checkFiles()
  wait("Inspector reflects disk timestamp") {
    js("document.querySelector('#inspector small')?.textContent === 'Edited \(hoursAgo)h ago'") as? Bool == true
  }
}
try inspectTime(2)
try ("# Other\n\nExternal timestamp sample.\n").write(to: other, atomically: true, encoding: .utf8)
try inspectTime(4)
try "# Other\n".write(to: other, atomically: true, encoding: .utf8)
try inspectTime(3)
js("document.querySelector('#inspector button').click()")
print("Inspector stayed in sync with three real disk modification times, both for touch-only and externally replaced Markdown.")
