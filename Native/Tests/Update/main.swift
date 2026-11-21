import AppKit
import Sparkle

let suite = Bundle.main.bundleIdentifier!
let marker = Bundle.main.bundleURL.deletingLastPathComponent()
let log = marker.appendingPathComponent("events")
func record(_ line: String) {
  if !FileManager.default.fileExists(atPath: log.path) { FileManager.default.createFile(atPath: log.path, contents: nil) }
  if let h = try? FileHandle(forWritingTo: log) {
    h.seekToEndOfFile()
    h.write(Data((line + "\n").utf8))
    h.closeFile()
  }
}
final class Runner: NSObject, NSApplicationDelegate {
  let updates = SamareUpdates()
  func applicationDidFinishLaunching(_ notification: Notification) {
    let build = Int(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as! String)!
    let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as! String
    let pending = ReleaseHistory.pending(build: build, version: version, defaults: .standard)
    record("launch \(build) card \(pending)")
    if pending { ReleaseHistory.acknowledge(build: build, version: version, defaults: .standard) }
    updates.publish = { [weak self] state in
      let phase = state["phase"] as? String ?? ""
      record("\(phase) \(state["percent"] ?? 0) \(state["message"] ?? "")")
      if phase == "available" {
        DispatchQueue.main.async { self?.updates.install() }
      } else if phase == "idle" && (state["message"] as? String)?.contains("up to date") == true || phase == "error" {
        DispatchQueue.main.asyncAfter(deadline: .now()+0.2) { NSApp.terminate(nil) }
      }
    }
    updates.start(localDirectory: marker.appendingPathComponent("channel"))
    if build == 2 {
      DispatchQueue.main.asyncAfter(deadline: .now()+1) { self.updates.check(interactive: true) }
    }
  }
  func applicationWillTerminate(_ notification: Notification) { updates.stop() }
}
let app = NSApplication.shared
let runner = Runner()
app.setActivationPolicy(.regular)
app.delegate = runner
app.run()
