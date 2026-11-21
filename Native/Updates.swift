import AppKit
#if canImport(Sparkle)
import Sparkle
#endif

// Keep the highest acknowledged build so downgrades and later reinstalls cannot repeat a card.
enum ReleaseHistory {
  static let key = "lastPresentedReleaseBuild"
  static let versionKey = "lastPresentedReleaseVersion"
  static func acknowledge(build: Int, version: String, defaults: UserDefaults?) {
    guard let prefs = defaults, build >= prefs.integer(forKey: key) else { return }
    prefs.set(build, forKey: key)
    prefs.set(version, forKey: versionKey)
  }
  static func pending(build: Int, version: String, defaults: UserDefaults?) -> Bool {
    guard let prefs = defaults, build > 0 else { return false }
    if prefs.object(forKey: key) == nil {
      if prefs.object(forKey: "didSeed") != nil || prefs.object(forKey: "settings") != nil {
        prefs.set(1, forKey: key)
      } else {
        acknowledge(build: build, version: version, defaults: prefs)
      }
    }
    let last = prefs.integer(forKey: key)
    if build == last && prefs.string(forKey: versionKey) == nil { prefs.set(version, forKey: versionKey) }
    guard build > last else { return false }
    if prefs.string(forKey: versionKey) == version {
      acknowledge(build: build, version: version, defaults: prefs)
      return false
    }
    return true
  }
}

#if canImport(Sparkle)
final class SamareUpdates: NSObject, SPUUserDriver, SPUUpdaterDelegate {
  var publish: (([String: Any]) -> Void)?
  private(set) var state: [String: Any] = ["phase": "idle"]
  private var updater: SPUUpdater?
  private var feed: URL?
  private var channel: Process?
  private var channelInput: Pipe?
  private var version = ""
  private var lastCheck = Date.distantPast
  private var expected: UInt64 = 0
  private var received: UInt64 = 0
  private var choice: ((SPUUserUpdateChoice) -> Void)?
  private var retryTermination: (() -> Void)?
  private var wasInteractive = false
  private var pendingCheck = false
  private var availabilityObservation: NSKeyValueObservation?

  private var hasSigningKey: Bool {
    Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") as? String != nil
  }

  func start(localDirectory: URL? = nil) {
    guard hasSigningKey else { return }
    if let address = Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") as? String,
       let url = URL(string: address), url.scheme == "https" || (url.scheme == "http" && url.host == "127.0.0.1") {
      configure(url)
      return
    }
    guard let directory = localDirectory, channel == nil,
      let script = Bundle.main.url(forResource: "channel", withExtension: "py", subdirectory: "Updates")
    else { return }
    let service = Process(), input = Pipe(), output = Pipe()
    service.executableURL = Bundle.main.resourceURL?.appendingPathComponent("Runtime/bin/python3")
    service.arguments = ["-I", "-u", script.path, directory.path]
    service.standardInput = input
    service.standardOutput = output
    do {
      try service.run()
      self.channel = service
      self.channelInput = input
      DispatchQueue.global().async { [weak self] in
        let line = output.fileHandleForReading.availableData
        DispatchQueue.main.async { [weak self] in
          guard let self, self.channel === service else { return }
          guard let port = Int(String(decoding: line, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)),
            (1...65535).contains(port), let url = URL(string: "http://127.0.0.1:\(port)/appcast.xml")
          else { self.stop(); self.report("error", "Could not open the local update channel."); return }
          self.configure(url)
        }
      }
    } catch { report("error", error.localizedDescription) }
  }

  func stop() {
    availabilityObservation = nil
    channelInput?.fileHandleForWriting.closeFile()
    channelInput = nil
    channel = nil
  }
  private func configure(_ url: URL) {
    feed = url
    let controller = SPUUpdater(hostBundle: .main, applicationBundle: .main, userDriver: self, delegate: self)
    do {
      try controller.start()
      updater = controller
      availabilityObservation = controller.observe(\.canCheckForUpdates, options: [.new]) { [weak self] _, change in
        guard change.newValue == true else { return }
        DispatchQueue.main.async { [weak self] in
          guard let self, self.pendingCheck else { return }
          self.check(interactive: true)
        }
      }
      check(interactive: pendingCheck)
    } catch { stop(); report("error", error.localizedDescription) }
  }
  func feedURLString(for updater: SPUUpdater) -> String? { feed?.absoluteString }
  func check(interactive: Bool) {
    guard hasSigningKey else {
      if interactive { report("idle", "This build has no update feed configured.") }
      return
    }
    if choice != nil {
      if interactive { report("available", "An update is available.") }
      return
    }
    if interactive {
      if let phase = state["phase"] as? String, ["installing", "retryQuit"].contains(phase) {
        publish?(state)
        return
      }
      if state["phase"] as? String == "checking", !pendingCheck { return }
      pendingCheck = true
      if state["phase"] as? String != "checking" { report("checking", "Checking for updates…") }
    } else if Date().timeIntervalSince(lastCheck) < 1800 || pendingCheck { return }
    guard let updater else {
      if interactive, channel == nil { start() }
      return
    }
    guard updater.canCheckForUpdates else { return }
    pendingCheck = false
    wasInteractive = interactive
    lastCheck = Date()
    if interactive { updater.checkForUpdates() } else { updater.checkForUpdatesInBackground() }
  }
  func install() {
    if let callback = choice {
      choice = nil
      report("installing")
      callback(.install)
    } else if let retry = retryTermination { retry() }
    else { check(interactive: true) }
  }
  private func report(_ phase: String, _ message: String = "", percent: Int = 0) {
    state = ["phase": phase, "version": version, "message": message, "percent": percent]
    publish?(state)
  }

  func show(_ request: SPUUpdatePermissionRequest, reply: @escaping (SUUpdatePermissionResponse) -> Void) {
    reply(SUUpdatePermissionResponse(automaticUpdateChecks: true, sendSystemProfile: false))
  }
  func showUserInitiatedUpdateCheck(cancellation: @escaping () -> Void) {
    if state["phase"] as? String != "checking" { report("checking", "Checking for updates…") }
  }
  func showUpdateFound(with appcastItem: SUAppcastItem, state: SPUUserUpdateState,
                       reply: @escaping (SPUUserUpdateChoice) -> Void) {
    version = appcastItem.displayVersionString
    choice = reply
    let notify = state.userInitiated || pendingCheck
    pendingCheck = false
    report("available", notify ? "An update is available." : "")
  }
  func showUpdateReleaseNotes(with downloadData: SPUDownloadData) {}
  func showUpdateReleaseNotesFailedToDownloadWithError(_ error: Error) {}
  func showUpdateNotFoundWithError(_ error: Error, acknowledgement: @escaping () -> Void) {
    report("idle", wasInteractive ? "Samare is up to date." : "")
    acknowledgement()
  }
  func showUpdaterError(_ error: Error, acknowledgement: @escaping () -> Void) {
    choice = nil; retryTermination = nil
    report("error", error.localizedDescription)
    acknowledgement()
  }
  func showDownloadInitiated(cancellation: @escaping () -> Void) {
    expected = 0; received = 0; report("installing")
  }
  func showDownloadDidReceiveExpectedContentLength(_ expectedContentLength: UInt64) { expected = expectedContentLength }
  func showDownloadDidReceiveData(ofLength length: UInt64) {
    received += length
    let percent = expected == 0 ? 0 : min(99, Int(100 * Double(received) / Double(expected)))
    if state["percent"] as? Int != percent { report("installing", percent: percent) }
  }
  func showDownloadDidStartExtractingUpdate() { report("installing", percent: 99) }
  func showExtractionReceivedProgress(_ progress: Double) {}
  func showReady(toInstallAndRelaunch reply: @escaping (SPUUserUpdateChoice) -> Void) { reply(.install) }
  func showInstallingUpdate(withApplicationTerminated applicationTerminated: Bool,
                            retryTerminatingApplication: @escaping () -> Void) {
    if !applicationTerminated {
      retryTermination = retryTerminatingApplication
      report("retryQuit", "Save your edits to finish updating.", percent: 99)
    }
  }
  func showUpdateInstalledAndRelaunched(_ relaunched: Bool, acknowledgement: @escaping () -> Void) {
    report("idle"); acknowledgement()
  }
  func dismissUpdateInstallation() { choice = nil; retryTermination = nil }
}
#endif
