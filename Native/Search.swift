import Foundation

// Weight names above parent paths. Recency breaks close matches without letting
// an unrelated recent file enter the results.
private func pickerScore(_ value: String, query: String) -> Int {
  let text = value.lowercased()
  if text == query { return 100 }
  if text.hasPrefix(query) { return 80 }
  if text.split(whereSeparator: { $0.isWhitespace || $0 == "_" || $0 == "-" })
    .contains(where: { $0.hasPrefix(query) }) { return 60 }
  return text.contains(query) ? 40 : 0
}

extension SamareHost {
  func search(_ input: [String: Any]) {
    let term = input["query"] as? String ?? ""
    let mode = input["mode"] as? String ?? "filename"
    let workspace = (input["workspace"] as? String).flatMap {
      $0.isEmpty ? nil : DocumentStore.canonical($0).path
    }
    let request = input["requestId"] ?? ""
    let picker = mode == "quickOpen"
    let pickerQuery = term.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
    let recent = Array((input["recent"] as? [String] ?? []).prefix(10))
    let targetPath = input["target"] as? String ?? activePath
    let target = targetPath.isEmpty ? nil : DocumentStore.canonical(targetPath)
    let folders = store.folders.filter {
      workspace == nil || workspace == "" || $0.path == workspace
    }
    let known = store.authorized.filter { file in
      workspace == nil || workspace == ""
        || folders.contains(where: { DocumentStore.contains($0, file) })
    }
    let queue: OperationQueue
    if let existing = searchQueues[mode] {
      queue = existing
    } else {
      queue = OperationQueue()
      queue.maxConcurrentOperationCount = 1
      queue.qualityOfService = .userInitiated
      searchQueues[mode] = queue
    }
    queue.cancelAllOperations()
    let task = BlockOperation()
    task.addExecutionBlock { [weak self, weak task] in
      guard let host = self else { return }
      guard let task else { return }
      let limit = 250
      var names: [[String: Any]] = []
      var ranked: [(score: Int, path: String, record: [String: Any])] = []
      var matches: [[String: Any]] = []
      var seen: Set<String> = []
      var matchedPaths: Set<String> = []
      func add(_ url: URL) {
        guard seen.insert(url.path).inserted, !task.isCancelled else { return }
        let meta = try? url.resourceValues(forKeys: [
          .isRegularFileKey, .isSymbolicLinkKey, .contentModificationDateKey,
        ])
        guard meta?.isRegularFile == true, meta?.isSymbolicLink != true else { return }
        // FileManager may enumerate /private/tmp while the workspace and open tab
        // use /tmp. Resolve only matching files, once per file, before emitting rows.
        lazy var record: [String: Any]? = {
          let actual = DocumentStore.canonical(url.path)
          guard !(mode == "backlinks" && actual == target),
            matchedPaths.insert(actual.path).inserted
          else { return nil }
          return [
            "path": actual.path, "name": actual.lastPathComponent,
            "modified": meta?.contentModificationDate?.timeIntervalSince1970 ?? 0,
          ]
        }()
        if picker {
          let score = max(pickerScore(url.lastPathComponent, query: pickerQuery),
                          pickerScore(url.deletingLastPathComponent().path, query: pickerQuery) / 2)
          guard score > 0, let item = record, let path = item["path"] as? String else { return }
          let total = score + (recent.firstIndex(of: path).map { 20 - 2 * $0 } ?? 0)
          let index = ranked.firstIndex {
            total > $0.score || total == $0.score && path.localizedStandardCompare($0.path) == .orderedAscending
          } ?? ranked.count
          if index < 40 {
            ranked.insert((total, path, item), at: index)
            if ranked.count > 40 { ranked.removeLast() }
          }
          return
        }
        let nameHit = term.isEmpty || url.lastPathComponent.localizedCaseInsensitiveContains(term)
        if mode != "backlinks" && nameHit && names.count < limit, let record {
          names.append(record.merging(["kind": "filename"]) { _, new in new })
        }
        guard mode != "filename", matches.count < limit, mode == "backlinks" || !term.isEmpty,
          let bytes = try? Data(contentsOf: url, options: .mappedIfSafe),
          let text = try? DocumentStore.decode(bytes)
        else { return }
        if mode == "backlinks" {
          guard let target, target != url,
            let line = SearchLinks.line(in: text, source: url, target: target, roots: folders),
            let record
          else { return }
          matches.append(record.merging(["kind": "backlink", "snippet": line]) { _, new in new })
          return
        }
        var number = 0
        text.enumerateLines { line, stop in
          number += 1
          if matches.count == limit || task.isCancelled {
            stop = true
            return
          }
          guard
            let range = line.range(of: term, options: [.caseInsensitive, .diacriticInsensitive]),
            let record
          else { return }
          let start =
            line.index(range.lowerBound, offsetBy: -55, limitedBy: line.startIndex)
            ?? line.startIndex
          matches.append(
            record.merging([
              "kind": "content", "snippet": String(line[start...].prefix(190)), "line": number,
            ]) { _, new in new })
        }
      }
      for file in known.sorted(by: { $0.path < $1.path }) { add(file) }
      for folder in folders {
        guard !task.isCancelled,
          let walk = FileManager.default.enumerator(
            at: folder, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey],
            options: [.skipsHiddenFiles, .skipsPackageDescendants])
        else { break }
        for case let url as URL in walk {
          if task.isCancelled || names.count == limit { break }
          if DocumentStore.excludedDirectories.contains(url.lastPathComponent)
            && DocumentStore.isDirectory(url)
          {
            walk.skipDescendants()
            continue
          }
          guard DocumentStore.extensions.contains(url.pathExtension.lowercased()) else { continue }
          add(url)
        }
      }
      if task.isCancelled { return }
      let byName: ([String: Any], [String: Any]) -> Bool = { a, b in
        let order = (a["name"] as? String ?? "").localizedStandardCompare(
          b["name"] as? String ?? "")
        if order == .orderedSame { return (a["line"] as? Int ?? 0) < (b["line"] as? Int ?? 0) }
        return order == .orderedAscending
      }
      let sorted = picker ? ranked.map(\.record)
        : Array((names.sorted(by: byName) + matches.sorted(by: byName)).prefix(limit))
      DispatchQueue.main.async { [weak host] in
        if !task.isCancelled {
          host?.emit(
            "searchResults", ["query": term, "mode": mode, "requestId": request, "entries": sorted])
        }
      }
    }
    queue.addOperation(task)
  }
}
