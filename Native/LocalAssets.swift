import Foundation
import UniformTypeIdentifiers

extension DocumentStore {
  func image(at url: URL) throws -> (data: Data, mime: String) {
    guard url.scheme == "samareasset", url.host == "local",
      let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
      let path = components.queryItems?.first(where: { $0.name == "document" })?.value,
      let ref = components.queryItems?.first(where: { $0.name == "src" })?.value,
      let source = ref.split(whereSeparator: { $0 == "?" || $0 == "#" }).first.map(String.init)?
        .removingPercentEncoding,
      !source.isEmpty, !source.hasPrefix("/"), URL(string: source)?.scheme == nil
    else { throw HostError("Invalid relative image.") }
    let document = try file(path)
    let parent = document.deletingLastPathComponent()
    let fileURL = Self.canonical(parent.appendingPathComponent(source).path)
    let roots = folders.filter { Self.contains($0, document) } + [parent]
    guard roots.contains(where: { Self.contains($0, fileURL) }),
      let type = UTType(filenameExtension: fileURL.pathExtension), type.conforms(to: .image),
      let mime = type.preferredMIMEType
    else { throw HostError("Image unavailable.") }
    return (try Data(contentsOf: fileURL, options: .mappedIfSafe), mime)
  }

  // Browser exports cannot load the app's custom scheme. Inline only assets
  // authorized by the same resolver that displayed the original document.
  func portableHTML(_ source: String) -> String {
    let expression = try! NSRegularExpression(pattern: #"\bsrc\s*=\s*(["'])(samareasset://[^"']+)\1"#)
    let input = source as NSString
    let result = NSMutableString(string: source)
    for match in expression.matches(in: source, range: NSRange(location: 0, length: input.length))
      .reversed()
    {
      let raw = input.substring(with: match.range(at: 2)).replacingOccurrences(
        of: "&amp;", with: "&")
      if let url = URL(string: raw), let asset = try? image(at: url) {
        result.replaceCharacters(
          in: match.range(at: 2),
          with: "data:\(asset.mime);base64,\(asset.data.base64EncodedString())")
      } else {
        result.replaceCharacters(in: match.range, with: "")
      }
    }
    return result as String
  }
}
