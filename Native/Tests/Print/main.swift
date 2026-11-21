import AppKit
import PDFKit
import WebKit

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let result = FileManager.default.temporaryDirectory.appendingPathComponent(
  "SamarePrint-" + UUID().uuidString + ".pdf")
let configuration = WKWebViewConfiguration()
configuration.defaultWebpagePreferences.allowsContentJavaScript = false
let job = HTMLPrintJob(configuration: configuration) { view in
  PrintDocument.make(view: view) { outcome in
    do {
      let rendered = try outcome.get()
      guard rendered.write(to: result), let doc = PDFDocument(url: result), doc.pageCount > 1,
        doc.page(at: 0)?.string?.contains("First marker") == true,
        doc.page(at: doc.pageCount - 1)?.string?.contains("Final marker") == true,
        (0..<doc.pageCount).compactMap({ doc.page(at: $0)?.string }).filter({ $0.contains("COLUMNHEADER") }).count >= 2,
        (0..<doc.pageCount).flatMap({ doc.page(at: $0)?.annotations ?? [] }).contains(where: { $0.url?.absoluteString == "https://example.com/test" })
      else {
        fputs("PDF pagination or content verification failed\n", stderr)
        exit(1)
      }
      print(
        "WKWebView generated and PDFKit read a \(doc.pageCount)-page PDF with repeated table headers, a clickable URL, and correct first and final pages"
      )
      try? FileManager.default.removeItem(at: result)
      exit(0)
    } catch {
      fputs(error.localizedDescription + "\n", stderr)
      exit(1)
    }
  }
}
DispatchQueue.main.async {
  let paragraphs = (1...130).map { "<p>Line \($0) of a pagination test.</p>" }.joined()
  let rows = (1...150).map { "<tr><td>Row \($0)</td><td>Table contents</td></tr>" }.joined()
  let table = "<table><thead><tr><th>COLUMNHEADER</th><th>Name</th></tr></thead><tbody>" + rows + "</tbody></table>"
  job.load(
    "<!doctype html><meta charset=utf-8><h1>First marker</h1>" + paragraphs
      + table + "<hr><a href=\"https://example.com/test\">Click here</a><h2>Final marker</h2>")
}
DispatchQueue.global().asyncAfter(deadline: .now() + 25) {
  fputs("PDF rendering timed out\n", stderr)
  exit(1)
}
app.run()
