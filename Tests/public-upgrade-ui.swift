import AppKit
import ApplicationServices

let arguments = CommandLine.arguments
let identifier = "io.github.digidai.samare"
let session = CGSessionCopyCurrentDictionary() as? [String: Any] ?? [:]
let locked = session["CGSSessionScreenIsLocked"] as? Bool ?? false
let apps = NSRunningApplication.runningApplications(withBundleIdentifier: identifier)

switch arguments[1] {
case "state":
    let processes = apps.map {
        ["pid": String($0.processIdentifier), "bundle": $0.bundleURL?.path ?? "",
         "started": String($0.launchDate?.timeIntervalSince1970 ?? 0)]
    }
    let data = try JSONSerialization.data(withJSONObject: [
        "locked": locked, "trusted": AXIsProcessTrusted(), "processes": processes,
    ])
    print(String(decoding: data, as: UTF8.self))
case "edit":
    let pid = Int32(arguments[2])!
    let expected = URL(fileURLWithPath: arguments[3]).resolvingSymlinksInPath()
    guard !locked, let app = apps.first(where: { $0.processIdentifier == pid }),
          app.bundleURL?.resolvingSymlinksInPath() == expected else { exit(2) }
    app.activate()
    Thread.sleep(forTimeInterval: 0.25)
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { exit(3) }
    func key(_ code: CGKeyCode, flags: CGEventFlags = [], text: String? = nil) {
        let source = CGEventSource(stateID: .privateState)
        for down in [true, false] {
            let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)!
            event.flags = flags
            if let text {
                Array(text.utf16).withUnsafeBufferPointer {
                    event.keyboardSetUnicodeString(stringLength: $0.count, unicodeString: $0.baseAddress)
                }
            }
            event.postToPid(pid)
        }
        Thread.sleep(forTimeInterval: 0.06)
    }
    key(125, flags: .maskCommand)
    key(36)
    for character in arguments[4] { key(0, text: String(character)) }
    key(1, flags: .maskCommand)
default:
    exit(2)
}
