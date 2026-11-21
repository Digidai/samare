import AppKit

final class StartupMark: NSView {
  private let background: NSColor
  private let mark = Bundle.main.url(forResource: "samare-mark", withExtension: "svg").flatMap(NSImage.init(contentsOf:))

  init(frame: NSRect, background: NSColor) {
    self.background = background
    super.init(frame: frame)
    autoresizingMask = [.width, .height]
    setAccessibilityLabel("Opening Samare")
  }
  required init?(coder: NSCoder) { nil }
  override func hitTest(_ point: NSPoint) -> NSView? { nil }
  override func draw(_ dirtyRect: NSRect) {
    background.setFill()
    dirtyRect.fill()
    mark?.draw(in: NSRect(x: bounds.midX - 34, y: bounds.midY + 18, width: 68, height: 68))
  }
}
