import Foundation

enum SearchLinks {
  private static let links = try! NSRegularExpression(
    pattern:
      #"\[\[([^\]|]+)(?:\|[^\]]*)?\]\]|!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))|^\s{0,3}\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))"#
  )
  private static let ticks = try! NSRegularExpression(pattern: "`+")

  // A code span ends only at another backtick run of exactly the same length.
  // Mask its contents, keeping line boundaries intact for the displayed snippets.
  private static func visibleLines(_ lines: [String]) -> [String] {
    guard lines.contains(where: { $0.contains("`") }) else { return lines }
    let paragraph = lines.joined(separator: "\n")
    var units = Array(paragraph.utf16)
    let runs = ticks.matches(in: paragraph, range: NSRange(location: 0, length: units.count)).map(
      \.range)
    var following = [Int?](repeating: nil, count: runs.count)
    var nextByLength: [Int: Int] = [:]
    for index in runs.indices.reversed() {
      following[index] = nextByLength.updateValue(index, forKey: runs[index].length)
    }
    var index = 0
    while index < runs.count {
      let start = runs[index].location
      var escapeStart = start
      while escapeStart > 0 && units[escapeStart - 1] == 92 { escapeStart -= 1 }
      if (start - escapeStart).isMultiple(of: 2), let close = following[index] {
        for offset in start..<NSMaxRange(runs[close]) where units[offset] != 10 {
          units[offset] = 32
        }
        index = close + 1
      } else {
        index += 1
      }
    }
    return String(decoding: units, as: UTF16.self).components(separatedBy: "\n")
  }

  static func line(in text: String, source: URL, target: URL, roots: [URL]) -> String? {
    var paragraph: [String] = []
    var answer: String?
    var fence: (Character, Int)?
    func finishParagraph() {
      if paragraph.isEmpty { return }
      for (original, visible) in zip(paragraph, visibleLines(paragraph)) {
        if matches(visible, source: source, target: target, roots: roots) {
          answer = String(original.trimmingCharacters(in: .whitespaces).prefix(190))
          break
        }
      }
      paragraph.removeAll(keepingCapacity: true)
    }
    text.enumerateLines { row, stop in
      let trimmed = row.trimmingCharacters(in: .whitespaces)
      let marker = trimmed.first
      let count =
        (marker == "`" || marker == "~") ? trimmed.prefix(while: { $0 == marker }).count : 0
      if let (char, length) = fence {
        if marker == char && count >= length && trimmed.dropFirst(count).isEmpty { fence = nil }
      } else if count >= 3 && !(marker == "`" && trimmed.dropFirst(count).contains("`")) {
        finishParagraph()
        fence = (marker!, count)
      } else if trimmed.isEmpty {
        finishParagraph()
      } else {
        paragraph.append(row)
      }
      stop = answer != nil
    }
    if answer == nil { finishParagraph() }
    return answer
  }

  private static func matches(_ row: String, source: URL, target: URL, roots: [URL]) -> Bool {
    let ns = row as NSString
    for match in links.matches(in: row, range: NSRange(location: 0, length: ns.length)) {
      guard
        let index = (1..<match.numberOfRanges).first(where: {
          match.range(at: $0).location != NSNotFound
        })
      else { continue }
      let raw = ns.substring(with: match.range(at: index)).components(separatedBy: "#")[0]
        .components(separatedBy: "?")[0]
      let value = (raw.removingPercentEncoding ?? raw).trimmingCharacters(in: .whitespaces)
      guard !value.isEmpty, URL(string: value)?.scheme == nil else { continue }
      let stem = URL(fileURLWithPath: value).pathExtension.isEmpty ? value + ".md" : value
      var hit = false
      if value.hasPrefix("/") {
        hit = roots.contains {
          DocumentStore.canonical($0.appendingPathComponent(String(stem.dropFirst())).path)
            == target
        }
      } else {
        hit =
          DocumentStore.canonical(
            source.deletingLastPathComponent().appendingPathComponent(stem).path) == target
      }
      if !hit && index == 1 && !stem.contains("/") {
        hit = target.lastPathComponent.caseInsensitiveCompare(stem) == .orderedSame
      }
      if hit { return true }
    }
    return false
  }
}
