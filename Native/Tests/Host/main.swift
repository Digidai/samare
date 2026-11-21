import AppKit

// Integration checks operate only on temporary fixtures and use volatile preferences.
precondition(CommandLine.arguments.contains("--isolated"))
let host = SamareHost()
let fm = FileManager.default
let parent = fm.temporaryDirectory.appendingPathComponent(
  "SamareHost-" + UUID().uuidString, isDirectory: true)
try fm.createDirectory(at: parent, withIntermediateDirectories: true)
defer { try? fm.removeItem(at: parent) }
let root = DocumentStore.canonical(parent.path)
try host.open(root)
try host.createFolder(["parent": root.path, "name": "Drafts"])
try host.createFolder(["parent": root.path, "name": "Notes"])
let drafts = root.appendingPathComponent("Drafts")
let notes = root.appendingPathComponent("Notes")
let initial = drafts.appendingPathComponent("Test.md")
try Data("A".utf8).write(to: initial)
try host.open(initial)
precondition(host.activePath == initial.path && host.tabs == [initial.path])
try host.rename(["path": initial.path, "name": "New.md"])
let renamed = drafts.appendingPathComponent("New.md")
precondition(host.activePath == renamed.path && fm.fileExists(atPath: renamed.path))
try host.move(["path": renamed.path, "parent": notes.path])
let moved = notes.appendingPathComponent("New.md")
precondition(host.activePath == moved.path && host.tabs == [moved.path])
try host.rename(["path": notes.path, "name": "Inbox"])
let newPath = root.appendingPathComponent("Inbox/New.md")
precondition(host.activePath == newPath.path && host.tabs == [newPath.path])
try fm.removeItem(at: newPath)
try host.restoreFile(newPath.path, "Recovered")
let first = try String(contentsOf: newPath, encoding: .utf8)
precondition(first == "Recovered")
try host.restoreFile(newPath.path, "Overwritten")
let second = try String(contentsOf: newPath, encoding: .utf8)
precondition(second == "Recovered")
print(
  "Workspace, create folder, open, file rename, cross-folder move, folder rename, restore and restore-conflict checks passed"
)

final class RecordingHost: SamareHost {
  var events: [(String, Any)] = []
  override func emit(_ type: String, _ value: Any) { events.append((type, value)) }
}
final class FixturePreferences: UserDefaults {
  var values: [String: Any] = [:]
  override func set(_ value: Any?, forKey key: String) { values[key] = value }
  override func string(forKey key: String) -> String? { values[key] as? String }
  override func stringArray(forKey key: String) -> [String]? { values[key] as? [String] }
  override func dictionary(forKey key: String) -> [String: Any]? { values[key] as? [String: Any] }
}

let audit = URL(fileURLWithPath: "/private/tmp").appendingPathComponent(
  "samare-workspaces-" + UUID().uuidString)
try fm.createDirectory(at: audit, withIntermediateDirectories: true)
defer { try? fm.removeItem(at: audit) }
let canonicalAudit = DocumentStore.canonical(audit.path)
let firstRoot = canonicalAudit.appendingPathComponent("One")
let secondRoot = canonicalAudit.appendingPathComponent("Two")
let shelf = secondRoot.appendingPathComponent("Notes")
let sibling = secondRoot.appendingPathComponent("Notes-backup")
for folder in [firstRoot, shelf, sibling] {
  try fm.createDirectory(at: folder, withIntermediateDirectories: true)
}
let one = firstRoot.appendingPathComponent("A.md")
let two = shelf.appendingPathComponent("B.md")
let closedFile = shelf.appendingPathComponent("Closed.md")
let lookalike = sibling.appendingPathComponent("Closed.md")
let loose = audit.appendingPathComponent("Loose.md")
for url in [one, two, closedFile, lookalike, loose] { try Data("hello".utf8).write(to: url) }
let prefs = FixturePreferences()
let session = RecordingHost()
session.defaults = prefs
try session.open(firstRoot)
try session.open(one)
try session.open(secondRoot)
try session.open(shelf)
session.events = []
try session.open(one)
precondition(session.events.map(\.0) == ["activeWorkspace", "document"])
precondition(
  (session.events[0].1 as? [String: String])?["path"] == firstRoot.path
    && session.activeWorkspace == firstRoot.path)
session.events = []
try session.open(two)
precondition(session.events.map(\.0) == ["activeWorkspace", "document"])
precondition(
  (session.events[0].1 as? [String: String])?["path"] == shelf.path
    && session.tabs == [one.path, two.path])
session.events = []
try session.open(two)
try session.open(loose)
precondition(session.events.map(\.0) == ["document", "document"])
try session.open(firstRoot)
precondition(
  session.activeWorkspace == firstRoot.path
    && session.activePath == DocumentStore.canonical(loose.path).path && session.tabs.count == 3)
print(
  "Cross-root publishes notify the sidebar before the document; same-root and standalone opens preserve sidebar choice; selecting a root leaves tabs open"
)

try session.open(lookalike)
try session.open(closedFile)
try session.open(two)
session.tabs.removeAll { $0 == closedFile.path || $0 == lookalike.path }
let renamedFile = shelf.appendingPathComponent("Revised.md")
try session.rename(["path": two.path, "name": renamedFile.lastPathComponent])
precondition(prefs.stringArray(forKey: "recent")?.first == renamedFile.path)
try session.rename(["path": shelf.path, "name": "Inbox"])
let inbox = secondRoot.appendingPathComponent("Inbox")
try session.move(["path": inbox.path, "parent": firstRoot.path])
let movedShelf = firstRoot.appendingPathComponent("Inbox")
let movedFile = movedShelf.appendingPathComponent("Revised.md")
let movedClosed = movedShelf.appendingPathComponent(closedFile.lastPathComponent)
let recent = prefs.stringArray(forKey: "recent") ?? []
precondition(Array(recent.prefix(3)) == [movedFile.path, movedClosed.path, lookalike.path])
precondition(session.recentMenu.items.compactMap { $0.representedObject as? String } == recent)
precondition(
  session.store.authorized.contains(movedClosed) && !session.store.authorized.contains(closedFile))
let restored = RecordingHost()
restored.defaults = prefs
restored.restore()
precondition(
  restored.activeWorkspace == movedShelf.path && restored.activePath == movedFile.path
    && restored.store.authorized.contains(movedClosed))
print(
  "File and parent rename/move rebase open and closed recent entries, menu, grants and restored tabs; sibling prefixes remain intact"
)

let unique = "uniquesearchfixture"
let uncached = firstRoot.appendingPathComponent("Unopened.txt")
let ignoredNames = ["target", "venv", ".venv", "node_modules", "dist", "build", "DerivedData", "Pods", "__pycache__"]
for name in ignoredNames {
  let folder = firstRoot.appendingPathComponent(name)
  try fm.createDirectory(at: folder, withIntermediateDirectories:true)
  try Data(unique.utf8).write(to: folder.appendingPathComponent("Ignored.md"))
}
let ordinary = firstRoot.appendingPathComponent("target-notes")
try fm.createDirectory(at:ordinary, withIntermediateDirectories:true)
let visible = ordinary.appendingPathComponent("Visible.md")
for file in [one, uncached, visible] { try Data(unique.utf8).write(to: file) }
let listingNames = Set(try session.store.listing(firstRoot).compactMap { $0["name"] as? String })
precondition(listingNames.contains("target-notes") && listingNames.isDisjoint(with: ignoredNames))
session.events = []
session.search(["mode": "content", "workspace": firstRoot.path, "query": unique, "requestId": 101])
let deadline = Date(timeIntervalSinceNow: 10)
while !session.events.contains(where: { $0.0 == "searchResults" }) && Date() < deadline {
  _ = RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.01))
}
let payload = session.events.first(where: { $0.0 == "searchResults" })?.1 as? [String: Any]
let paths = (payload?["entries"] as? [[String: Any]])?.compactMap { $0["path"] as? String } ?? []
precondition(
  paths.sorted() == [one.path, uncached.path, visible.path].sorted() && one.path.hasPrefix("/tmp/")
    && uncached.path.hasPrefix("/tmp/"))
print(
  "Listing and content search excluded nine build/environment folders, kept target-notes and returned unique canonical paths for open and unopened files"
)

let pickerFolder = firstRoot.appendingPathComponent("Deck")
try fm.createDirectory(at: pickerFolder, withIntermediateDirectories: true)
for i in 0..<45 {
  try Data().write(to: pickerFolder.appendingPathComponent("Page-\(i).md"))
}
let aDeck = firstRoot.appendingPathComponent("Deck.md")
let recentDeck = pickerFolder.appendingPathComponent("Deck.md")
try Data().write(to: aDeck)
try Data().write(to: recentDeck)
session.events = []
session.search(["mode":"quickOpen", "workspace":firstRoot.path, "query":"deck", "recent":[recentDeck.path]])
let pickerDeadline = Date(timeIntervalSinceNow: 10)
while !session.events.contains(where: { $0.0 == "searchResults" }) && Date() < pickerDeadline {
  _ = RunLoop.current.run(mode:.default, before:Date(timeIntervalSinceNow:0.01))
}
let pickerReply = session.events.first(where: { $0.0 == "searchResults" })?.1 as? [String: Any]
let results = (pickerReply?["entries"] as? [[String: Any]])?.compactMap { $0["path"] as? String } ?? []
precondition(results.count == 40 && Set(results).count == 40)
precondition(Array(results.prefix(2)) == [recentDeck.path, aDeck.path])
precondition(results.dropFirst(2).allSatisfy { $0.hasPrefix(pickerFolder.path + "/Page-") })
print("Quick Open includes parent-folder matches, ranks filenames and recent files first, and caps results at 40")

// Each item belongs to this unique fixture, including anything temporarily sent to the system Trash.
let trashWorkspace = root.appendingPathComponent("BatchTrashTests")
let selectedFolder = trashWorkspace.appendingPathComponent("Group")
let systemTrash = FileManager.default
try systemTrash.createDirectory(at: selectedFolder, withIntermediateDirectories: true)
let child = selectedFolder.appendingPathComponent("Child.md")
let standalone = trashWorkspace.appendingPathComponent("One-" + UUID().uuidString + ".md")
let kept = trashWorkspace.appendingPathComponent("Other.md")
for url in [child, standalone, kept] { try Data(url.lastPathComponent.utf8).write(to: url) }
let trashHost = RecordingHost()
try trashHost.open(trashWorkspace)
for url in [child, standalone, kept] { try trashHost.open(url) }
func batch(_ id: String, _ urls: [URL]) -> [String:Any] { ["id": id, "paths":urls.map(\.path)] }
func trashErrors(_ id: String) -> [String] {
  let info = trashHost.events.filter { $0.0 == "trashBatchResult" }
    .compactMap { $0.1 as? [String:Any] }.last { $0["id"] as? String == id }
  return info!["errors"] as! [String]
}
let testSelection = batch("trash-commit", [selectedFolder, child, standalone, standalone])
trashHost.stageTrash(testSelection)
precondition(trashHost.trashSelections["trash-commit"]?.count == 3)
var trashedFixtures: [(URL, URL)] = []
trashHost.trashBatch(testSelection) { url in
  var destination: NSURL?
  try systemTrash.trashItem(at: url, resultingItemURL: &destination)
  if let destination { trashedFixtures.append((url, destination as URL)) }
}
defer {
  // Restore only files identified by the URLs the system returned for this operation.
  for (original, destination) in trashedFixtures {
    if !systemTrash.fileExists(atPath: original.path) { try? systemTrash.moveItem(at: destination, to: original) }
  }
}
precondition(trashErrors("trash-commit").isEmpty, String(describing: trashErrors("trash-commit")))
precondition(trashedFixtures.count == 2 && trashHost.tabs == [kept.path] && trashHost.activePath == kept.path)
precondition(!systemTrash.fileExists(atPath: selectedFolder.path) && !systemTrash.fileExists(atPath: standalone.path))
for (_, destination) in trashedFixtures { precondition(systemTrash.fileExists(atPath: destination.path)) }
let replacement = trashWorkspace.appendingPathComponent("Replacement.md")
let held = trashWorkspace.appendingPathComponent("Before.md")
try Data("before".utf8).write(to: replacement)
let secondBatch = batch("trash-replaced", [replacement, kept])
trashHost.stageTrash(secondBatch)
try systemTrash.moveItem(at: replacement, to: held)
try Data("new occupant".utf8).write(to: replacement)
let fakeTrash = root.appendingPathComponent("isolated-test-destination.md")
trashHost.trashBatch(secondBatch) { url in try systemTrash.moveItem(at: url, to: fakeTrash) }
let occupant = try String(contentsOf: replacement, encoding:.utf8)
precondition(occupant == "new occupant" && trashErrors("trash-replaced").count == 1)
precondition(systemTrash.fileExists(atPath: fakeTrash.path) && !systemTrash.fileExists(atPath: kept.path))
let link = trashWorkspace.appendingPathComponent("Link.md")
try systemTrash.createSymbolicLink(at: link, withDestinationURL: held)
for improper in [trashWorkspace, link, audit] {
  trashHost.stageTrash(batch("improper", [improper]))
  precondition(trashHost.trashSelections["improper"] == nil)
}
print("Batch Trash moved two fixture items through macOS Trash, deduplicated a selected descendant, retained a same-name replacement, completed the other item, and rejected workspace roots and symlinks")

// Re-activation must refresh the visible directory even before its next poll.
let largeWorkspace = root.appendingPathComponent("Return to window")
try fm.createDirectory(at: largeWorkspace, withIntermediateDirectories:true)
for i in 0..<1200 { try Data().write(to:largeWorkspace.appendingPathComponent("Note-\(i).md")) }
let watcher = RecordingHost()
try watcher.open(largeWorkspace)
let watched = DocumentStore.canonical(largeWorkspace.path).path
watcher.watchedFolders[watched] = "before-create"
try Data("External file".utf8).write(to:largeWorkspace.appendingPathComponent("Latest.md"))
watcher.isReady = true
let began = Date()
watcher.applicationDidBecomeActive(Notification(name:NSApplication.didBecomeActiveNotification))
let listingEvent = watcher.events.last { $0.0 == "listing" }?.1 as? [String:Any]
let returned = listingEvent?["entries"] as? [[String:Any]]
precondition(returned?.count == 1201 && returned?.contains { ($0["name"] as? String) == "Latest.md" } == true)
print("On activation, refreshed 1,201 workspace files including the new external note in \(Int(Date().timeIntervalSince(began)*1000)) ms.")

let releaseSuite = "io.github.digidai.samare.release-history." + UUID().uuidString
let releasePrefs = UserDefaults(suiteName: releaseSuite)!
defer { releasePrefs.removePersistentDomain(forName:releaseSuite) }
precondition(!ReleaseHistory.pending(build:1, version:"1.0", defaults:releasePrefs))
precondition(ReleaseHistory.pending(build:2, version:"1.1", defaults:releasePrefs))
ReleaseHistory.acknowledge(build:2, version:"1.1", defaults:releasePrefs)
precondition(!ReleaseHistory.pending(build:3, version:"1.1", defaults:releasePrefs))
precondition(!ReleaseHistory.pending(build:1, version:"1.0", defaults:releasePrefs))
precondition(ReleaseHistory.pending(build:4, version:"1.2", defaults:releasePrefs))
print("Release history handles first install, a later version, rebuilds of the same version and downgrade/re-upgrade.")
