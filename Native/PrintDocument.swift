import AppKit
import PDFKit
import WebKit

// Lay out the print document in page-sized CSS columns so WebKit can choose
// line and table breaks before capturing each page as vector PDF content.
enum PrintDocument {
  static func make(view: WKWebView, completion: @escaping (Result<PDFDocument, Error>) -> Void) {
    let paper = CGSize(width: 595.28, height: 841.89)
    let margin: CGFloat = 42
    let scale: CGFloat = 0.75
    let width = floor((paper.width - margin * 2) / scale)
    let height = floor((paper.height - margin * 2) / scale)
    view.frame = CGRect(x: 0, y: 0, width: width, height: height)
    let paginate = """
      await document.fonts.ready;
      const body = document.body;
      body.style.cssText += ';display:block!important;margin:0!important;padding:0!important;width:'+w+'px!important;height:'+h+'px!important;max-width:none!important;overflow:visible!important;background:white!important;color:#151515!important';
      const sheet = document.createElement('div');
      sheet.style.cssText = 'position:relative;box-sizing:border-box;column-gap:0;column-fill:auto;column-width:'+w+'px;width:'+w+'px;height:'+h+'px;overflow:visible';
      const rules = document.createElement('style');
      rules.textContent = 'html{margin:0;padding:0;overflow:visible!important}h1,h2,h3,h4,h5,h6{break-after:avoid-column}img,svg{max-width:100%!important;max-height:'+h+'px}tr,blockquote,figure,pre,.de-preview,.de-codebox{break-inside:avoid-column}pre{white-space:pre-wrap;overflow-wrap:anywhere}p,li{orphans:2;widows:2}';
      document.head.append(rules);
      while (body.firstChild) sheet.append(body.firstChild);
      body.append(sheet);
      const pageOf = rect => Math.max(0, Math.floor((rect.left + 0.5) / w));
      const isHeading = e => e?.matches('h1,h2,h3,h4,h5,h6');
      function firstContentRect(element) {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        for (let node; (node=walker.nextNode());) {
          const start = node.data.search(/\\S/);
          if (start < 0) continue;
          const range = document.createRange();
          range.setStart(node,start); range.setEnd(node,start+1);
          const rect = range.getClientRects()[0];
          if (rect?.width && rect.height) return rect;
        }
        return element.getClientRects()[0];
      }
      // WebKit can place a heading in a column even with break-after:avoid-column.
      // Check where the following content is drawn before splitting tables.
      for (const heading of sheet.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
        if (isHeading(heading.previousElementSibling)) continue;
        let next = heading.nextElementSibling;
        while (isHeading(next)) next = next.nextElementSibling;
        if (!next) continue;
        const title = firstContentRect(heading), following = firstContentRect(next);
        if (title && following && pageOf(title) < pageOf(following) && title.top > 1)
          heading.style.breakBefore = 'column';
      }
      // WebKit does not repeat a table header between CSS columns. Split at row
      // boundaries using actual line heights, reserving a header on every page.
      for (const table of Array.from(sheet.querySelectorAll('table'))) {
        const header = table.tHead;
        if (!header || table.tBodies.length !== 1 || !table.tBodies[0].rows.length) continue;
        const rows = Array.from(table.tBodies[0].rows);
        if (rows.some(row => Array.from(row.cells).some(cell => cell.rowSpan > 1))) continue;
        const measurements = rows.map(row => row.getBoundingClientRect().height);
        const headerHeight = header.getBoundingClientRect().height;
        const top = header.getBoundingClientRect().top - sheet.getBoundingClientRect().top;
        let group = [];
        const groups = [group];
        let used = top + headerHeight + 2;
        rows.forEach((row, i) => {
          if (group.length && used + measurements[i] > h) {
            group = []; groups.push(group); used = headerHeight + 2;
          }
          group.push(row); used += measurements[i];
        });
        if (groups.length < 2) continue;
        const template = table.cloneNode(false);
        template.removeAttribute('id');
        const columns = table.querySelector(':scope > colgroup');
        const widths = Array.from(header.rows[0].cells, cell => cell.getBoundingClientRect().width);
        for (const [i, group] of groups.entries()) {
          const part = template.cloneNode(false);
          if (i) part.style.breakBefore = 'column';
          if (i === 0 && table.caption) part.append(table.caption.cloneNode(true));
          if (columns) part.append(columns.cloneNode(true));
          const head = header.cloneNode(true);
          Array.from(head.rows[0].cells).forEach((cell, j) => cell.style.width = widths[j] + 'px');
          part.append(head);
          const body = part.createTBody();
          group.forEach(row => body.append(row));
          if (i + 1 === groups.length && table.tFoot) part.append(table.tFoot.cloneNode(true));
          table.before(part);
        }
        table.remove();
      }
      for (const hr of sheet.querySelectorAll('hr')) {
        const rect = hr.getBoundingClientRect();
        const prev = hr.previousElementSibling, next = hr.nextElementSibling;
        if (!prev || !next || pageOf(prev.getClientRects()[prev.getClientRects().length-1] || rect) !== pageOf(rect) ||
            pageOf(next.getClientRects()[0] || rect) !== pageOf(rect)) hr.style.visibility = 'hidden';
      }
      const links = [];
      for (const link of sheet.querySelectorAll('a[href]')) {
        const href = link.getAttribute('href');
        let dest = null;
        if (href.startsWith('#')) {
          try { dest = document.getElementById(decodeURIComponent(href.slice(1)))?.getBoundingClientRect(); } catch {}
        }
        if (!dest && !/^(?:https?:|mailto:)/i.test(href)) continue;
        for (const rect of link.getClientRects()) {
          if (!rect.width || !rect.height) continue;
          const page = pageOf(rect);
          links.push({href, page, x:rect.x-page*w, y:rect.y, width:rect.width, height:rect.height,
            destPage:dest ? pageOf(dest) : -1, destY:dest?.y ?? 0});
        }
      }
      return {count:Math.max(1,Math.ceil((sheet.scrollWidth - 1)/w)), links};
      """
    view.callAsyncJavaScript(paginate, arguments: ["w": width, "h": height], in: nil, in: .page) {
      outcome in
      switch outcome {
      case .failure(let error): completion(.failure(error))
      case .success(let value):
        guard let layout = value as? [String: Any], let count = layout["count"] as? Int, count > 0 else {
          completion(.failure(HostError("Unable to paginate the document.")))
          return
        }
        let output = NSMutableData()
        var bounds = CGRect(origin: .zero, size: paper)
        guard let consumer = CGDataConsumer(data: output),
          let writer = CGContext(consumer: consumer, mediaBox: &bounds, nil)
        else {
          completion(.failure(HostError("Unable to create PDF output.")))
          return
        }
        func capture(_ page: Int) {
          let config = WKPDFConfiguration()
          config.rect = CGRect(x: CGFloat(page) * width, y: 0, width: width, height: height)
          view.createPDF(configuration: config) { result in
            do {
              let data = try result.get()
              guard let provider = CGDataProvider(data: data as CFData),
                let pdf = CGPDFDocument(provider), let source = pdf.page(at: 1)
              else { throw HostError("A print page could not be rendered.") }
              writer.beginPDFPage(nil)
              writer.saveGState()
              writer.translateBy(x: margin, y: paper.height - margin - height * scale)
              writer.scaleBy(x: scale, y: scale)
              writer.drawPDFPage(source)
              writer.restoreGState()
              writer.endPDFPage()
              if page + 1 < count {
                capture(page + 1)
                return
              }
              writer.closePDF()
              guard let document = PDFDocument(data: output as Data) else {
                throw HostError("The PDF document could not be assembled.")
              }
              for link in layout["links"] as? [[String: Any]] ?? [] {
                guard let index = link["page"] as? Int, let target = document.page(at: index),
                  let href = link["href"] as? String, let x = link["x"] as? CGFloat,
                  let y = link["y"] as? CGFloat, let w = link["width"] as? CGFloat,
                  let h = link["height"] as? CGFloat else { continue }
                let rect = CGRect(x: margin + x * scale, y: paper.height - margin - (y + h) * scale,
                                  width: w * scale, height: h * scale)
                let annotation = PDFAnnotation(bounds: rect, forType: .link, withProperties: nil)
                if let dest = link["destPage"] as? Int, dest >= 0, let destPage = document.page(at: dest) {
                  let point = CGPoint(x: margin, y: paper.height - margin - (link["destY"] as? CGFloat ?? 0) * scale)
                  annotation.destination = PDFDestination(page: destPage, at: point)
                } else if let url = URL(string: href) {
                  annotation.url = url
                }
                let border = PDFBorder()
                border.lineWidth = 0
                annotation.border = border
                target.addAnnotation(annotation)
              }
              completion(.success(document))
            } catch {
              writer.closePDF()
              completion(.failure(error))
            }
          }
        }
        capture(0)
      }
    }
  }
}

final class HTMLPrintJob: NSObject, WKNavigationDelegate {
  private let view: WKWebView
  private let completion: (WKWebView) -> Void
  init(configuration: WKWebViewConfiguration, completion: @escaping (WKWebView) -> Void) {
    self.completion = completion
    view = WKWebView(
      frame: NSRect(x: 0, y: 0, width: 720, height: 920), configuration: configuration)
    super.init()
    view.navigationDelegate = self
  }
  func load(_ html: String) { view.loadHTMLString(html, baseURL: nil) }
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    DispatchQueue.main.async { self.completion(webView) }
  }
}
