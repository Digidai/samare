import AppKit
import ApplicationServices

enum SaveSheet {
  static func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var value: CFTypeRef?
    AXUIElementCopyAttributeValue(element, name as CFString, &value)
    return value
  }

  static func find(_ element: AXUIElement, depth: Int = 0,
                   where matches: (AXUIElement) -> Bool) -> AXUIElement? {
    if matches(element) { return element }
    guard depth < 25 else { return nil }
    for child in attribute(element, "AXChildren") as? [AXUIElement] ?? [] {
      if let found = find(child, depth: depth + 1, where: matches) { return found }
    }
    return nil
  }

  static func matching(_ root: AXUIElement, role: String, title: String? = nil,
                       value: String? = nil) -> AXUIElement? {
    find(root) { node in
      guard attribute(node,"AXRole") as? String == role else { return false }
      if role == "AXButton", (attribute(node,"AXEnabled") as? NSNumber)?.boolValue == false { return false }
      if let title, attribute(node,"AXTitle") as? String != title { return false }
      if let value, attribute(node,"AXValue") as? String != value { return false }
      return true
    }
  }

  static func until(_ title: String, _ probe: () -> AXUIElement?) throws -> AXUIElement {
    let end = Date().addingTimeInterval(12)
    repeat {
      if let result = probe() { return result }
      Thread.sleep(forTimeInterval: 0.07)
    } while Date() < end
    throw HostError("Could not find " + title + " in the test application's save sheet.")
  }

  static func press(_ node: AXUIElement) throws {
    let label = attribute(node,"AXTitle") as? String ?? attribute(node,"AXDescription") as? String ?? "control"
    let status = AXUIElementPerformAction(node,kAXPressAction as CFString)
    guard status == .success else {
      var actions: CFArray?
      AXUIElementCopyActionNames(node,&actions)
      throw HostError("The save sheet rejected " + label + " (AX " + String(status.rawValue) + ", actions " + String(describing:actions) + ").")
    }
  }

  // The NSSavePanel content runs in a different process. Operate only on the
  // sheet owned by the supplied fixture PID, never on the frontmost application.
  static func drive(pid: pid_t, reopening: Bool) throws {
    guard AXIsProcessTrusted() else { throw HostError("This GUI test requires macOS Accessibility access.") }
    let app = AXUIElementCreateApplication(pid)
    let sheet = try until("save sheet") { matching(app,role:"AXSheet") }
    let folder = reopening ? "Second" : "First"
    _ = try until("displayed destination " + folder) {
      matching(sheet,role:"AXPopUpButton",value:folder)
    }
    if reopening {
      try press(until("Cancel") { matching(sheet,role:"AXButton",title:"Cancel") })
      return
    }
    if matching(sheet,role:"AXButton",title:"New Folder") == nil {
      let disclosure = try until("expanded destination controls") { matching(sheet,role:"AXDisclosureTriangle") }
      try press(disclosure)
    }
    try press(until("New Folder") { matching(sheet,role:"AXButton",title:"New Folder") })
    let create = try until("Create folder") { matching(app,role:"AXButton",title:"Create") }
    let input = try until("new folder name") {
      find(app) { node in
        attribute(node,"AXRole") as? String == "AXTextField" &&
          (attribute(node,"AXFocused") as? NSNumber)?.boolValue == true
      }
    }
    guard AXUIElementSetAttributeValue(input,kAXValueAttribute as CFString,"Second" as CFString) == .success,
          attribute(input,"AXValue") as? String == "Second"
    else { throw HostError("The folder name did not change.") }
    try press(create)
    _ = try until("chosen destination Second") { matching(sheet,role:"AXPopUpButton",value:"Second") }
    try press(until("Save") { matching(sheet,role:"AXButton",title:"Save") })
  }
}
