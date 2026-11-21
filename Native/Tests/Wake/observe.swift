import AppKit

// Passive observer. These are real system broadcasts; the fixture never requests sleep.
func record(_ event: String) {
  let value: [String: Any] = ["event": event, "epochMs": Int(Date().timeIntervalSince1970 * 1000)]
  let bytes = try! JSONSerialization.data(withJSONObject: value)
  FileHandle.standardOutput.write(bytes + Data([10]))
}
let center = NSWorkspace.shared.notificationCenter
let sleeping = center.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { _ in record("willSleep") }
let waking = center.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { _ in record("didWake") }
record("observing")
RunLoop.main.run()
