import AppKit
import ApplicationServices

let args = CommandLine.arguments
let application = Int32(args[1]).flatMap { NSRunningApplication(processIdentifier: $0) }
  ?? NSRunningApplication.runningApplications(withBundleIdentifier: args[1]).last
guard let app = application else { exit(2) }
let root = AXUIElementCreateApplication(app.processIdentifier)
AXUIElementSetAttributeValue(root, "AXManualAccessibility" as CFString, kCFBooleanTrue)
func attr(_ node: AXUIElement, _ name: String) -> AnyObject? {
  var value: CFTypeRef?
  AXUIElementCopyAttributeValue(node, name as CFString, &value)
  return value
}
let action = args[2], query = args.dropFirst(3).first ?? ""
if action == "quit" { exit(app.terminate() ? 0 : 1) }
if action == "pid" { print(app.processIdentifier); exit(0) }
var lines: [String] = []
func walk(_ node: AXUIElement, _ depth: Int) -> Bool {
  if depth > 24 { return false }
  let role = attr(node, "AXRole") as? String ?? ""
  let values = ["AXTitle","AXDescription","AXValue","AXHelp"].compactMap { attr(node,$0) as? String }
  let label = values.joined(separator:" | ")
  if !label.isEmpty { lines.append(role + " " + String(label.prefix(130))) }
  if action == "button" && role == "AXButton" && values.contains(query) &&
       AXUIElementPerformAction(node, kAXPressAction as CFString) == .success { return true }
  if !query.isEmpty && values.contains(where:{$0.localizedCaseInsensitiveContains(query)}) {
    if action == "find" { return true }
    if action == "press", AXUIElementPerformAction(node, kAXPressAction as CFString) == .success { return true }
  }
  return (attr(node, "AXChildren") as? [AXUIElement] ?? []).contains { walk($0, depth+1) }
}
let children = attr(root, "AXWindows") as? [AXUIElement] ?? []
if action == "menu" {
  if let menu = attr(root, "AXMenuBar") {
    func pressMenu(_ item: AXUIElement) -> Bool {
      if (attr(item, "AXTitle") as? String ?? "").hasPrefix(query) {
        return AXUIElementPerformAction(item, kAXPressAction as CFString) == .success
      }
      return (attr(item,"AXChildren") as? [AXUIElement] ?? []).contains(where:pressMenu)
    }
    if pressMenu(unsafeBitCast(menu, to:AXUIElement.self)) { exit(0) }
  }
}
let ok = children.contains { walk($0,0) }
if action == "dump" { print(lines.joined(separator:"\n")); exit(0) }
exit(ok ? 0 : 1)
