// Render Samare's shared vector artwork into the point sizes used by Finder.
import AppKit
import Foundation

guard CommandLine.arguments.count == 2 else {
  fputs("Usage: swift Native/Icon/generate.swift OUTPUT.iconset\n", stderr)
  exit(2)
}

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
  .deletingLastPathComponent().deletingLastPathComponent()
let source = root.appendingPathComponent("Resources/samare-mark.svg")
let artwork = try Data(contentsOf: source)
let compactVector = try XMLDocument(data: artwork)
guard let veins = try compactVector.nodes(forXPath: "//*[@id='fine-veins']").first else {
  fatalError("Missing fine-veins artwork group")
}
veins.detach()
guard let full = NSImage(data: artwork), let compact = NSImage(data: compactVector.xmlData) else {
  fatalError("Unable to load Samare vector artwork")
}

let iconset = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)

for points in [16, 32, 128, 256, 512] {
  for scale in [1, 2] {
    let side = points * scale
    let suffix = scale == 1 ? "" : "@2x"
    let url = iconset.appendingPathComponent("icon_\(points)x\(points)\(suffix).png")
    let pixels = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: side, pixelsHigh: side,
      bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
      colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    let canvas = NSRect(x: 0, y: 0, width: side, height: side)
    pixels.size = canvas.size

    // Small Finder and menu icons use more of the canvas and omit the wing engraving.
    let isSmall = points <= 32
    let inset = isSmall ? 0 : (canvas.width * 0.04).rounded()
    let frame = canvas.insetBy(dx: inset, dy: inset)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: pixels)
    (isSmall ? compact : full).draw(in: frame, from: .zero, operation: .sourceOver, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()
    try pixels.representation(using: .png, properties: [:])!.write(to: url)
  }
}
