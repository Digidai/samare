import Foundation

let fm = FileManager.default
let temp = fm.temporaryDirectory.appendingPathComponent("samare-tests-" + UUID().uuidString)
try fm.createDirectory(at: temp, withIntermediateDirectories: true)
defer { try? fm.removeItem(at: temp) }
let folder = temp.appendingPathComponent("sample", isDirectory: true)
let out = temp.appendingPathComponent("external.md")
try fm.createDirectory(at: folder, withIntermediateDirectories: true)
let file = folder.appendingPathComponent("Café.md")
let other = folder.appendingPathComponent("Update.md")
let sub = folder.appendingPathComponent("Notes", isDirectory: true)
try Data("# Outside".utf8).write(to: out)
try Data("# Update".utf8).write(to: other)
try fm.createDirectory(at: sub, withIntermediateDirectories: true)
let base = "# Café\r\n"
var bytes = Data([0xef, 0xbb, 0xbf])
bytes.append(contentsOf: base.utf8)
try bytes.write(to: file)
let alias = folder.appendingPathComponent("outside.md")
try fm.createSymbolicLink(at: alias, withDestinationURL: out)
var store = DocumentStore()
_ = try store.grantFolder(folder)
func check(_ value: Bool, _ message: String) { if !value { fatalError(message) } }
check(try store.read(file) == base, "BOM stripping / CRLF")
let listing = try store.listing(folder)
check(
  listing.count == 3 && listing.first?["name"] as? String == "Notes",
  "Folder listing and symbolic links")
check(listing.allSatisfy { $0["modified"] is Double }, "Modification time")
do {
  _ = try store.file(alias.path)
  fatalError("Unauthorized symlink")
} catch is HostError {}
let update = "Updated\r\n"
if case .saved = try store.write(update, to: file, replacing: base) {
} else {
  fatalError("Save failed")
}
check(try Data(contentsOf: file).starts(with: [0xef, 0xbb, 0xbf]), "Save discarded UTF-8 BOM")
if case .conflict(let disk) = try store.write("local", to: file, replacing: base) {
  check(disk == update, "Incorrect conflict contents")
} else {
  fatalError("Concurrent edit overwritten")
}
let canon = DocumentStore.canonical(file.path)
let src = DocumentStore.canonical(other.path)
check(
  SearchLinks.line(in: "[link](Caf%C3%A9.md#now)", source: src, target: canon, roots: [folder])
    != nil, "Markdown backlink")
check(
  SearchLinks.line(in: "[[Café#now|c]]", source: src, target: canon, roots: [folder]) != nil,
  "Wiki backlink")
check(
  SearchLinks.line(in: "```md\n[[Café]]\n```", source: src, target: canon, roots: [folder]) == nil,
  "Fenced code is not a backlink")
check(
  SearchLinks.line(in: "[a]: <Caf%C3%A9.md>", source: src, target: canon, roots: [folder]) != nil,
  "Reference definition")
print("Native document store and backlinks checks passed")
let attachment = folder.appendingPathComponent("Chart One.png")
try Data([1, 2, 3]).write(to: attachment)
var local = URLComponents()
local.scheme = "samareasset"
local.host = "local"
local.path = "/"
local.queryItems = [
  URLQueryItem(name: "document", value: file.path),
  URLQueryItem(name: "src", value: "Chart%20One.png?v=2"),
]
let assetURL = local.url!
let embedded = store.portableHTML(
  "<img src=\"" + assetURL.absoluteString.replacingOccurrences(of: "&", with: "&amp;") + "\">")
check(
  embedded == "<img src=\"data:image/png;base64,AQID\">",
  "Portable HTML embeds a local image with an encoded filename")
print("Authorized local image and portable HTML export checks passed")

func linksToFixture(_ sourceText: String) -> Bool {
  SearchLinks.line(in: sourceText, source: src, target: canon, roots: [folder]) != nil
}
check(!linksToFixture("Try `[[Café]]` as an example."), "Inline code is not a backlink")
check(
  !linksToFixture("Try ``an inner ` tick and [label](Caf%C3%A9.md)``."),
  "Unequal backtick run inside code is not a closing delimiter")
check(
  !linksToFixture("Inline `line 1\n[[Café]]` ends here."), "Multiline code span is not a backlink")
check(linksToFixture("`[[Other]]` then [[Café]]."), "Real wiki link after code on the same line")
check(
  linksToFixture("[Café](Caf%C3%A9.md) then `[[Other]]`."),
  "Real Markdown link before code on the same line")
check(linksToFixture("An unmatched ` with [[Café]]."), "Unmatched backtick stays literal")
check(
  linksToFixture("Escaped \\` followed by [[Café]] and a literal \\`."),
  "Escaped delimiters stay literal")
print("Inline-code and same-line backlink regression checks passed")
