import Foundation

struct TrashIdentity: Equatable {
  let volume: UInt64
  let inode: UInt64

  init(_ url: URL) throws {
    let info = try FileManager.default.attributesOfItem(atPath: url.path)
    guard let volume = info[.systemNumber] as? NSNumber,
      let inode = info[.systemFileNumber] as? NSNumber
    else { throw HostError("Unable to identify the selected item.") }
    self.volume = volume.uint64Value
    self.inode = inode.uint64Value
  }
}

extension SamareHost {
  private func checkedTrashItem(_ path: String) throws -> URL {
    guard path.hasPrefix("/") else { throw HostError("Choose a file in the workspace.") }
    let requested = URL(fileURLWithPath: path).standardizedFileURL
    let item = try grantedItem(path)
    // A listed file can be replaced by a symbolic link while Undo is available.
    guard requested.path == item.path else { throw HostError("The selected path has changed.") }
    guard
      !store.folders.contains(item)
        || store.folders.contains(where: { $0 != item && DocumentStore.contains($0, item) })
    else { throw HostError("A workspace root cannot be moved to Trash from its file tree.") }
    return item
  }

  func stageTrash(_ data: [String: Any]) {
    guard let id = data["id"] as? String, let paths = data["paths"] as? [String] else { return }
    var snapshot: [String: TrashIdentity] = [:]
    do {
      for path in Set(paths) {
        let item = try checkedTrashItem(path)
        snapshot[item.path] = try TrashIdentity(item)
      }
      trashSelections[id] = snapshot
    } catch {
      emit("trashStageFailed", ["id": id, "message": error.localizedDescription])
    }
  }

  func trashBatch(
    _ data: [String: Any],
    moving move: (URL) throws -> Void = {
      try FileManager.default.trashItem(at: $0, resultingItemURL: nil)
    }
  ) {
    guard let id = data["id"] as? String else { return }
    var errors: [String] = []
    defer { emit("trashBatchResult", ["id": id, "errors": errors] as [String: Any]) }
    guard let paths = data["paths"] as? [String], !paths.isEmpty else {
      errors.append("Choose a file in the workspace.")
      return
    }
    guard let snapshot = trashSelections.removeValue(forKey: id) else {
      errors.append("The selection changed. Choose the items again.")
      return
    }
    let authorized: [URL]
    do { authorized = try paths.map(checkedTrashItem) } catch {
      errors.append(error.localizedDescription)
      return
    }
    var seen = Set<String>()
    let unique = authorized.filter { seen.insert($0.path).inserted }
    let top = unique.filter { item in
      !unique.contains { $0.path != item.path && DocumentStore.contains($0, item) }
    }
    var parents = Set<URL>()
    var moved: [URL] = []
    for item in top {
      do {
        _ = try checkedTrashItem(item.path)
        guard try TrashIdentity(item) == snapshot[item.path] else {
          throw HostError("A different item now uses this name. It was kept.")
        }
        try move(item)
        moved.append(item)
        parents.insert(item.deletingLastPathComponent())
        emit("trashed", ["path": item.path])
      } catch { errors.append("\(item.lastPathComponent): \(error.localizedDescription)") }
    }
    guard !moved.isEmpty else { return }
    func removed(_ path: String) -> Bool {
      let url = URL(fileURLWithPath: path)
      return moved.contains { DocumentStore.contains($0, url) }
    }
    tabs.removeAll(where: removed)
    lastSeen = lastSeen.filter { !removed($0.key) }
    signatures = signatures.filter { !removed($0.key) }
    missing = missing.filter { !removed($0) }
    watchedFolders = watchedFolders.filter { !removed($0.key) }
    let removedWorkspaces = store.folders.filter { removed($0.path) }
    for folder in removedWorkspaces { store.closeFolder(folder) }
    if !tabs.contains(activePath) { activePath = tabs.last ?? "" }
    if !store.folders.contains(where: { $0.path == activeWorkspace }) {
      activeWorkspace = store.folders.first?.path ?? ""
    }
    if let prefs = defaults, let recent = prefs.stringArray(forKey: "recent") {
      prefs.set(recent.filter { !removed($0) }, forKey: "recent")
      rebuildRecent()
    }
    if removedWorkspaces.isEmpty { persist() } else { foldersChanged() }
    for parent in parents { try? refresh(parent) }
  }
}
