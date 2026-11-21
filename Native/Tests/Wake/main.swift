import AppKit

// Exercise the actual app's NSWorkspace registration and helper invocation, without
// sleeping the Mac. The separate physical fixture listens for real OS notifications.
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let host = SamareHost()
let scratch = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
host.isolatedHome = scratch
host.observeSystemWake()
func bridge(_ arguments: [String]) throws -> String {
  var reply: Result<String, Error>?
  host.bridge(arguments) { reply = $0 }
  let deadline = Date().addingTimeInterval(12)
  while reply == nil, Date() < deadline {
    RunLoop.current.run(until: Date().addingTimeInterval(0.03))
  }
  guard let reply else { throw HostError("Bridge command timed out") }
  return try reply.get()
}
func postAndWait(running: Bool) throws {
  host.lastBridgeStatus = [:]
  NSWorkspace.shared.notificationCenter.post(name: NSWorkspace.didWakeNotification, object: NSWorkspace.shared)
  let deadline = Date().addingTimeInterval(12)
  while (host.lastBridgeStatus["running"] as? Bool) != running && Date() < deadline {
    RunLoop.current.run(until: Date().addingTimeInterval(0.03))
  }
  guard (host.lastBridgeStatus["running"] as? Bool) == running else { throw HostError("Unexpected post-wake bridge state") }
}
func verify() throws {
  // The wake handler must honor opt-out, and recover an interrupted enabled service.
  try postAndWait(running: false)
  _ = try bridge(["enable"])
  defer { _ = try? bridge(["stop"]) }
  let fixture = scratch.appendingPathComponent("Native wake.txt")
  try "Native wake round trip".write(to: fixture, atomically: true, encoding: .utf8)
  let old = try bridge(["url", fixture.path]); let url = URL(string: old)!
  _ = try bridge(["stop"])
  try postAndWait(running: true)
  let urlAgain = try bridge(["url", fixture.path]); guard old == urlAgain else { throw HostError("Existing URL changed") }
  let endpoint = url.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("api").appendingPathComponent(url.lastPathComponent)
  let current = try JSONSerialization.jsonObject(with: Data(contentsOf: endpoint)) as? [String: Any]
  guard current?["text"] as? String == "Native wake round trip" else { throw HostError("Post-wake data unavailable") }
  print("Native didWake observer kept disabled Bridge off and recovered an interrupted service with unchanged URL and document contents.")
}
do { try verify() } catch { fputs("Wake test failed: \(error)\n", stderr); exit(1) }
