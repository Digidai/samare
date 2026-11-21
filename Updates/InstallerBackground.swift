import AppKit

// Finder's installer window uses points. Export a 2× image for Retina displays.
let output = URL(fileURLWithPath: CommandLine.arguments[1])
let canvas = NSSize(width: 720, height: 440)
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1440, pixelsHigh: 880,
  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
  colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
bitmap.size = canvas
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
let pine = NSColor(srgbRed: 0.082, green: 0.180, blue: 0.161, alpha: 1)
let evergreen = NSColor(srgbRed: 0.212, green: 0.337, blue: 0.278, alpha: 1)
let straw = NSColor(srgbRed: 0.957, green: 0.827, blue: 0.573, alpha: 1)
let copper = NSColor(srgbRed: 0.980, green: 0.761, blue: 0.600, alpha: 1)
NSGradient(starting: pine, ending: evergreen)!.draw(in: NSRect(origin: .zero, size: canvas), angle: 112)
func text(_ value: String, y: CGFloat, size: CGFloat, weight: NSFont.Weight, color: NSColor) {
  let label = NSAttributedString(string: value, attributes: [.font: NSFont.systemFont(ofSize: size, weight: weight),
    .foregroundColor: color])
  label.draw(at: NSPoint(x: (canvas.width - label.size().width) / 2, y: y))
}
text("Install Samare", y: 338, size: 34, weight: .semibold, color: .white)
text("Drag Samare into Applications.", y: 309, size: 15, weight: .regular, color: straw)
let arrow = NSBezierPath()
arrow.move(to: NSPoint(x: 315, y: 194))
arrow.line(to: NSPoint(x: 401, y: 194))
arrow.move(to: NSPoint(x: 389, y: 206))
arrow.line(to: NSPoint(x: 401, y: 194))
arrow.line(to: NSPoint(x: 389, y: 182))
arrow.lineWidth = 3
arrow.lineJoinStyle = .round
arrow.lineCapStyle = .round
copper.setStroke()
arrow.stroke()
try bitmap.representation(using: .png, properties: [:])!.write(to: output)
