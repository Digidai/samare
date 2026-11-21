import AppKit
import WebKit

// Only an unshown window, private pasteboards, volatile app preferences and temporary source files.
precondition(CommandLine.arguments.contains("--isolated"))
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
final class TestHost: SamareHost {
  var problems = [String]()
  override func fail(_ text: String) { problems.append(text) }
}
final class Drop: NSObject, NSDraggingInfo {
  let draggingPasteboard = NSPasteboard.withUniqueName()
  let draggingLocation: NSPoint
  let draggingDestinationWindow: NSWindow?
  let draggingSource: Any? = nil
  let draggingSourceOperationMask: NSDragOperation = .copy
  let draggedImageLocation: NSPoint = .zero
  let draggedImage: NSImage? = nil
  let draggingSequenceNumber = 1
  var draggingFormation = NSDraggingFormation.none
  var animatesToDestination = false
  var numberOfValidItemsForDrop = 0
  var springLoadingHighlight = NSSpringLoadingHighlight.none
  func resetSpringLoading() {}
  func slideDraggedImage(to screenPoint: NSPoint) {}
  override func namesOfPromisedFilesDropped(atDestination dropDestination: URL) -> [String]? { nil }
  func enumerateDraggingItems(
    options enumOpts: NSDraggingItemEnumerationOptions = [], for view: NSView?,
    classes classArray: [AnyClass], searchOptions: [NSPasteboard.ReadingOptionKey: Any] = [:],
    using block: (NSDraggingItem, Int, UnsafeMutablePointer<ObjCBool>) -> Void
  ) {}
  init(_ urls: [URL], in view: NSView, x: Double = 60, y: Double = 145) {
    draggingDestinationWindow = view.window
    draggingLocation = view.convert(
      CGPoint(x: x, y: view.isFlipped ? y : view.bounds.height - y), to: nil)
    super.init()
    draggingPasteboard.writeObjects(urls.map { $0 as NSURL })
  }
  deinit { draggingPasteboard.releaseGlobally() }
}

let host = TestHost()
let resources = URL(fileURLWithPath: CommandLine.arguments[1]).standardizedFileURL
let config = WKWebViewConfiguration()
config.websiteDataStore = .nonPersistent()
config.userContentController.add(host, name: "host")
config.setURLSchemeHandler(host, forURLScheme: "samareasset")
let view = FinderDropWebView(
  frame: CGRect(x: 0, y: 0, width: 960, height: 740), configuration: config)
host.web = view
view.dropHost = host
host.window = EditorWindow(
  contentRect: view.bounds, styleMask: [.borderless], backing: .buffered, defer: false)
host.window.contentView = view
view.loadFileURL(resources.appendingPathComponent("index.html"), allowingReadAccessTo: resources)

func wait(_ title: String, until: () -> Bool) {
  let end = Date().addingTimeInterval(9)
  while !until() {
    guard Date() < end else {
      fatalError(
        "Timed out: " + title + "; latest errors: " + host.problems.joined(separator: ", "))
    }
    RunLoop.current.run(until: Date().addingTimeInterval(0.025))
  }
}
func script(_ code: String) -> Any? {
  var done = false
  var answer: Any?
  view.evaluateJavaScript(code) { value, error in
    precondition(error == nil, error?.localizedDescription ?? "")
    answer = value
    done = true
  }
  wait("web script") { done }
  return answer
}
func dispatch(_ urls: [URL], x: Double = 60, y: Double = 145) -> Bool {
  let info = Drop(urls, in: view, x: x, y: y)
  guard !view.draggingEntered(info).isEmpty else {
    view.draggingExited(info)
    return false
  }
  _ = view.draggingUpdated(info)
  guard view.prepareForDragOperation(info) else {
    view.draggingExited(info)
    return false
  }
  return view.performDragOperation(info)
}

let fm = FileManager.default
let parent = DocumentStore.canonical(
  fm.temporaryDirectory.appendingPathComponent("finder-drop-" + UUID().uuidString).path)
try fm.createDirectory(at: parent, withIntermediateDirectories: true)
defer { try? fm.removeItem(at: parent) }
let workspace = parent.appendingPathComponent("Notebook", isDirectory: true)
let chapters = workspace.appendingPathComponent("Chapters", isDirectory: true)
try fm.createDirectory(at: chapters, withIntermediateDirectories: true)
let note = chapters.appendingPathComponent("Draft.md")
let csv = workspace.appendingPathComponent("Numbers.csv")
try Data("# Draft\n\nDrop the image here.\n".utf8).write(to: note)
try Data("Value\n1\n".utf8).write(to: csv)
let image = parent.appendingPathComponent("My snapshot.png")
let unicodeImage = parent.appendingPathComponent("评审 图 (第二版).png")
let internalImage = workspace.appendingPathComponent("保留原名 (第 2 张).png")
let pixel = Data(
  base64Encoded:
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6jO6YAAAAASUVORK5CYII=")!
try pixel.write(to: image)
try pixel.write(to: unicodeImage)
try pixel.write(to: internalImage)
precondition(
  FinderDropPlan.classify([workspace, chapters]) == .rejected("Drop one folder at a time"))
precondition(
  FinderDropPlan.classify([note, image]) == .rejected("Drop one kind of item at a time"))
let unsupported = parent.appendingPathComponent("Archive.zip")
try Data().write(to: unsupported)
precondition(
  FinderDropPlan.classify([unsupported]) == .rejected("Samare opens Markdown and text files"))
precondition(
  FinderDropPlan.classify([parent.appendingPathComponent("Gone.md")])
    == .rejected("Dropped items are unavailable"))
let textBoard = NSPasteboard.withUniqueName()
textBoard.setString(note.path, forType: .string)
precondition(FinderDropPlan.fileURLs(in: textBoard) == nil)
textBoard.releaseGlobally()
let filenameBoard = NSPasteboard.withUniqueName()
filenameBoard.setPropertyList([note.path, csv.path], forType: .init("NSFilenamesPboardType"))
precondition(FinderDropPlan.fileURLs(in: filenameBoard)?.map(\.path) == [note.path, csv.path])
filenameBoard.releaseGlobally()
wait("bundled workspace page") {
  host.isReady && script("typeof SamareFinderDrop === 'object'") as? Bool == true
}
precondition(view.registeredDraggedTypes.contains(.fileURL))
precondition(dispatch([workspace]))
wait("open directory") { host.activeWorkspace == workspace.path }
_ = script(
  "document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',metaKey:true,bubbles:true}))")
wait("palette before dropping files") {
  script("!!document.querySelector('#choicebox')") as? Bool == true
}
precondition(dispatch([csv, note]))
wait("two open documents") {
  host.tabs.count == 2 && host.activePath == note.path
    && script("document.querySelector('.ProseMirror h1')?.textContent") as? String == "Draft"
}
precondition(script("document.querySelector('#overlay').hidden") as? Bool == true)
let coords =
  script(
    "(() => { const b=document.querySelector('.ProseMirror p').getBoundingClientRect();return [b.x+8,b.y+8] })()"
  ) as! [Double]
let assets = workspace.appendingPathComponent("assets", isDirectory: true)
try fm.createDirectory(at: assets, withIntermediateDirectories: false)
let existing = assets.appendingPathComponent("my-snapshot.png")
try Data("untouched".utf8).write(to: existing)
precondition(dispatch([internalImage, image, unicodeImage], x: coords[0], y: coords[1]))
wait("all three images saved to the drop target") {
  (try? String(contentsOf: note, encoding: .utf8))?.contains("../assets/image.png") == true
}
let disk = try String(contentsOf: note, encoding: .utf8)
let existingBytes = try Data(contentsOf: existing)
let copyBytes = try Data(contentsOf: assets.appendingPathComponent("my-snapshot-2.png"))
precondition(disk.contains("![保留原名 (第 2 张)](<../保留原名 (第 2 张).png>)"))
precondition(disk.contains("![评审 图 (第二版)](<../assets/image.png>)"))
precondition(existingBytes == Data("untouched".utf8) && copyBytes == pixel)
let rendered = """
  (() => { const images = [...document.querySelectorAll('.ProseMirror img.de-image')];
    return images.length === 3 && images.every(i => i.complete && i.naturalWidth === 1 && i.naturalHeight === 1);
  })()
  """
wait("Unicode, space and parenthesis images actually decode in WebKit") {
  script(rendered) as? Bool == true
}
try host.open(csv)
wait("switched to table") { script("!!document.querySelector('.de-data')") as? Bool == true }
try host.open(note)
wait("images still decode after Markdown is parsed again") { script(rendered) as? Bool == true }
let before = host.tabs
precondition(!dispatch([workspace, note]))
precondition(host.tabs == before)
_ = script(
  "document.querySelector('[data-cmd=sidebar]').blur(); document.dispatchEvent(new KeyboardEvent('keydown',{key:',',metaKey:true,bubbles:true}))"
)
let blocked = Drop([csv], in: view)
_ = view.draggingEntered(blocked)
wait("blocked overlay") {
  script("document.querySelector('#finder-drop span').textContent") as? String
    == "Close this panel before opening dropped items"
}
precondition(!view.prepareForDragOperation(blocked))
view.draggingExited(blocked)
_ = script("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
let rollbackNote = chapters.appendingPathComponent("Rollback.md")
try Data("# Rollback\n\nEmpty note.\n".utf8).write(to: rollbackNote)
precondition(dispatch([rollbackNote]))
wait("rollback note ready") {
  script("document.querySelector('.ProseMirror h1')?.textContent") as? String == "Rollback"
}
_ = script("window.SamareDropEditor.insert=()=>false; true")
let after =
  script(
    "(() => {const b=document.querySelector('.ProseMirror p').getBoundingClientRect();return [b.x+8,b.y+8]})()"
  ) as! [Double]
precondition(dispatch([image], x: after[0], y: after[1]))
wait("failed insert reports error and releases its new copy") {
  !host.problems.isEmpty
    && !fm.fileExists(atPath: assets.appendingPathComponent("my-snapshot-3.png").path)
}
precondition(
  (try? String(contentsOf: rollbackNote, encoding: .utf8)) == "# Rollback\n\nEmpty note.\n")
let emptyRoot = parent.appendingPathComponent("Cleanup", isDirectory: true)
try fm.createDirectory(at: emptyRoot, withIntermediateDirectories: false)
let emptyNote = emptyRoot.appendingPathComponent("Empty.md")
try Data().write(to: emptyNote)
var failed = FinderImageImport()
do {
  try failed.materialize([image, unsupported], under: emptyRoot, for: emptyNote)
  fatalError("Expected invalid image")
} catch { failed.discardCopies() }
precondition(!fm.fileExists(atPath: emptyRoot.appendingPathComponent("assets").path))
print(
  "Finder drop passed with private AppKit pasteboards and a bundled WKWebView: multi-file, workspace, mixed input, modal, existing-asset reuse, external copy, collision and failed-insert cleanup"
)
