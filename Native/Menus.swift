import AppKit

extension SamareHost {
  func makeMenus() {
    let main = NSMenu()
    func menu(_ name: String) -> NSMenu {
      let item = NSMenuItem()
      main.addItem(item)
      let group = NSMenu(title: name)
      item.submenu = group
      return group
    }
    func native(
      _ group: NSMenu, _ name: String, _ selector: Selector, _ key: String = "",
      _ mods: NSEvent.ModifierFlags = [.command]
    ) {
      let item = group.addItem(withTitle: name, action: selector, keyEquivalent: key)
      item.keyEquivalentModifierMask = mods
    }
    func command(
      _ group: NSMenu, _ name: String, _ id: String, _ key: String = "",
      _ mods: NSEvent.ModifierFlags = [.command]
    ) {
      let item = group.addItem(
        withTitle: name, action: #selector(sendCommand(_:)), keyEquivalent: key)
      item.target = self
      item.representedObject = id
      item.keyEquivalentModifierMask = mods
    }
    let app = menu("Samare")
    native(app, "About Samare", #selector(NSApplication.orderFrontStandardAboutPanel(_:)))
    app.addItem(.separator())
    command(app, "Check for Updates…", "checkUpdates")
    command(app, "Settings…", "settings", ",")
    app.addItem(.separator())
    native(app, "Hide Samare", #selector(NSApplication.hide(_:)), "h")
    native(
      app, "Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h",
      [.command, .option])
    native(app, "Show All", #selector(NSApplication.unhideAllApplications(_:)))
    app.addItem(.separator())
    native(app, "Quit Samare", #selector(NSApplication.terminate(_:)), "q")
    let file = menu("File")
    command(file, "New File…", "newFile", "n")
    command(file, "New Folder…", "createFolder", "n", [.command, .shift])
    command(file, "Add Workspace…", "openFolder", "o")
    command(file, "Open File…", "openFiles", "o", [.command, .shift])
    let recent = NSMenuItem(title: "Open Recent", action: nil, keyEquivalent: "")
    file.addItem(recent)
    recent.submenu = recentMenu
    rebuildRecent()
    file.addItem(.separator())
    command(file, "Save", "save", "s")
    command(file, "Save As…", "saveAs", "s", [.command, .shift])
    command(file, "Reopen Closed Tab", "reopenTab", "t", [.command, .shift])
    command(file, "Close Tab", "closeTab", "w")
    native(file, "Close Window", #selector(NSWindow.performClose(_:)), "w", [.command, .shift])
    file.addItem(.separator())
    command(file, "Export HTML…", "exportHTML")
    command(file, "Export PDF…", "exportPDF")
    command(file, "Print…", "print", "p", [.command, .option])
    let edit = menu("Edit")
    native(edit, "Undo", Selector(("undo:")), "z")
    native(edit, "Redo", Selector(("redo:")), "z", [.command, .shift])
    edit.addItem(.separator())
    native(edit, "Cut", #selector(NSText.cut(_:)), "x")
    native(edit, "Copy", #selector(NSText.copy(_:)), "c")
    native(edit, "Paste", #selector(NSText.paste(_:)), "v")
    native(edit, "Select All", #selector(NSText.selectAll(_:)), "a")
    edit.addItem(.separator())
    command(edit, "Find…", "find", "f")
    let view = menu("View")
    command(view, "Toggle Sidebar", "sidebar", "\\")
    command(view, "Focus Mode", "focus", "f", [.command, .shift])
    command(view, "Toggle Theme", "theme", "l", [.command, .shift])
    view.addItem(.separator())
    command(view, "Zoom In", "zoomIn", "=")
    command(view, "Zoom Out", "zoomOut", "-")
    command(view, "Actual Size", "zoomReset", "0")
    view.addItem(.separator())
    native(
      view, "Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f",
      [.command, .control])
    view.addItem(.separator())
    command(view, "Switch to File…", "quickOpen", "p")
    command(view, "Command Palette…", "palette", "k")
    command(view, "Use in Agent…", "agent", "l")
    command(view, "Refresh Files", "refresh", "r")
    let win = menu("Window")
    native(win, "Minimize", #selector(NSWindow.performMiniaturize(_:)), "m")
    native(win, "Zoom", #selector(NSWindow.performZoom(_:)))
    NSApp.windowsMenu = win
    let help = menu("Help")
    command(help, "Keyboard Shortcuts…", "shortcuts", "/")
    command(help, "What’s New in Samare", "whatsNew")
    help.addItem(.separator())
    command(help, "Refresh Files", "refresh")
    NSApp.helpMenu = help
    NSApp.mainMenu = main
  }
  @objc func sendCommand(_ sender: NSMenuItem) {
    if let id = sender.representedObject as? String { emit("command", id) }
  }
  func rebuildRecent() {
    recentMenu.removeAllItems()
    for path in defaults?.stringArray(forKey: "recent") ?? []
    where FileManager.default.fileExists(atPath: path) {
      let item = recentMenu.addItem(
        withTitle: URL(fileURLWithPath: path).lastPathComponent, action: #selector(openRecent(_:)),
        keyEquivalent: "")
      item.toolTip = path
      item.representedObject = path
      item.target = self
    }
    if recentMenu.numberOfItems > 0 { recentMenu.addItem(.separator()) }
    let clear = recentMenu.addItem(
      withTitle: "Clear Menu", action: #selector(clearRecent), keyEquivalent: "")
    clear.target = self
  }
  @objc func openRecent(_ sender: NSMenuItem) {
    if let path = sender.representedObject as? String {
      do { try open(URL(fileURLWithPath: path)) } catch { fail(error.localizedDescription) }
    }
  }
  @objc func clearRecent() {
    defaults?.removeObject(forKey: "recent")
    rebuildRecent()
  }
}
