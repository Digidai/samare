import AppKit

final class EditorWindow: NSWindow {
  private var positionsWindowedControls = false
  private var enteringFullScreen = false
  private var scheduled = false
  private var adjusting = false
  private let watchedViews = NSHashTable<NSView>.weakObjects()
  private let controlTypes: [NSWindow.ButtonType] = [.closeButton, .miniaturizeButton, .zoomButton]

  func configureWindowedControls() {
    guard !positionsWindowedControls else { return }
    positionsWindowedControls = true
    let center = NotificationCenter.default
    for name in [
      NSWindow.didResizeNotification, NSWindow.didBecomeKeyNotification,
      NSWindow.didDeminiaturizeNotification, NSWindow.didEndSheetNotification,
      NSWindow.didChangeBackingPropertiesNotification,
    ] {
      center.addObserver(self, selector: #selector(scheduleAlignment), name: name, object: self)
    }
    center.addObserver(
      self, selector: #selector(willEnterFullScreen),
      name: NSWindow.willEnterFullScreenNotification, object: self)
    center.addObserver(
      self, selector: #selector(resumeWindowedControls), name: NSWindow.didExitFullScreenNotification,
      object: self)
    alignWindowedControls()
  }

  @objc private func willEnterFullScreen() { enteringFullScreen = true }
  @objc func resumeWindowedControls() {
    enteringFullScreen = false
    scheduleAlignment()
  }

  @objc private func scheduleAlignment() {
    guard !adjusting, !scheduled, positionsWindowedControls else { return }
    scheduled = true
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.scheduled = false
      self.alignWindowedControls()
    }
  }

  override func update() {
    super.update()
    // AppKit may rebuild the titlebar (sharing overlays, scale or key state).
    // Reconnect to the current standard buttons after that layout settles.
    if positionsWindowedControls { alignWindowedControls() }
  }

  private func observeFrame(of view: NSView) {
    guard !watchedViews.contains(view) else { return }
    watchedViews.add(view)
    view.postsFrameChangedNotifications = true
    NotificationCenter.default.addObserver(
      self, selector: #selector(scheduleAlignment),
      name: NSView.frameDidChangeNotification, object: view)
  }

  private func alignWindowedControls() {
    guard !adjusting, !enteringFullScreen, !styleMask.contains(.fullScreen), !isMiniaturized,
      attachedSheet == nil, contentView != nil
    else { return }
    adjusting = true
    defer { adjusting = false }
    let scale = max(1, backingScaleFactor)
    for (index, type) in controlTypes.enumerated() {
      guard let button = standardWindowButton(type), let parent = button.superview else { continue }
      observeFrame(of: button)
      observeFrame(of: parent)
      let target = parent.convert(
        NSPoint(x: CGFloat(31 + 23 * index), y: frame.height - 20.5), from: nil)
      let x = ((target.x - button.frame.width / 2) * scale).rounded() / scale
      let y = ((target.y - button.frame.height / 2) * scale).rounded() / scale
      let desired = NSPoint(x: x, y: y)
      if button.frame.origin != desired { button.setFrameOrigin(desired) }
    }
  }

  // The web toolbar leaves its middle region empty. Handle its mouse-down directly
  // so dragging works even when the web process delivers script messages later.
  override func sendEvent(_ event: NSEvent) {
    if event.type == .leftMouseDown, !styleMask.contains(.fullScreen) {
      let point = event.locationInWindow
      if point.y >= frame.height - 37 && point.x >= 122 && point.x < frame.width - 180 {
        if event.clickCount == 2 { performZoom(nil) } else { performDrag(with: event) }
        return
      }
    }
    super.sendEvent(event)
  }
}
