import AppKit
import PDFKit
import WebKit

// Deliberately place a magenta rule at each end and the middle of the first
// page. Read the actual rasterized PDF to distinguish a rule from whitespace.
func coloredRows(_ page: PDFPage) throws -> Int {
  guard let pdf = page.pageRef else { throw HostError("No PDF page") }
  let bounds = pdf.getBoxRect(.mediaBox)
  let width = Int(bounds.width * 2), height = Int(bounds.height * 2)
  var bytes = [UInt8](repeating: 255, count: width * height * 4)
  return try bytes.withUnsafeMutableBytes { memory in
    guard let ctx = CGContext(data: memory.baseAddress, width: width, height: height, bitsPerComponent: 8,
      bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { throw HostError("Unable to sample PDF") }
    ctx.scaleBy(x: 2, y: 2); ctx.drawPDFPage(pdf)
    let p = memory.bindMemory(to: UInt8.self)
    return (0..<height).filter { y in
      let i = 4 * (y * width + width / 2)
      return p[i] > 180 && Int(p[i])-Int(p[i+1]) > 40 && Int(p[i+2])-Int(p[i+1]) > 40
    }.count
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let test = HTMLPrintJob(configuration: WKWebViewConfiguration()) { view in
  PrintDocument.make(view: view) { result in
    do {
      let doc = try result.get()
      guard let first = doc.page(at: 0), doc.pageCount >= 8 else { throw HostError("Not enough pages") }
      var rules: [Int] = []
      let pages = (0..<doc.pageCount).compactMap { doc.page(at: $0)?.string }
      for i in 0..<doc.pageCount { rules.append(try coloredRows(doc.page(at: i)!)) }
      guard first.string?.contains("First paragraph") == true, (1...5).contains(rules[0]), rules.dropFirst().allSatisfy({$0==0}) else { throw HostError("Unexpected printed dividers by page: \(rules)") }
      for level in 1...6 {
        guard let index = pages.firstIndex(where: {$0.contains("HeadingLevel\(level)")}), pages[index].contains("FollowingText\(level)") else { throw HostError("Heading \(level) orphaned: \(pages)") }
      }
      print("\(doc.pageCount) PDF pages: six heading levels stay with following text; only the interior divider paints (colored raster rows per page: \(rules)).")
      exit(0)
    } catch { fputs("\(error.localizedDescription)\n",stderr); exit(1) }
  }
}
let boundaries = (1...6).map { n in
  "<section style='break-before:column'><div class='spacer'>Level \(n)</div><h\(n)>HeadingLevel\(n)</h\(n)><p>FollowingText\(n)</p></section>"
}.joined()
let html = """
<!doctype html><meta charset=utf-8><style>*{box-sizing:border-box}p,h1,h2,h3,h4,h5,h6{font:16px/20px sans-serif;margin:0}hr{border:0;background:magenta;height:2px;margin:0}.spacer{height:988px}</style>
<main><hr><p>First paragraph</p><hr><p>Keep the interior rule above this line</p><hr><p style='break-before:column'>Starts a page without a rule</p>\(boundaries)<hr></main>
"""
DispatchQueue.main.async { test.load(html) }
DispatchQueue.global().asyncAfter(deadline: .now()+35) { exit(2) }
app.run()
