import Quartz
import UniformTypeIdentifiers

@objc(SamarePreviewProvider)
final class PreviewProvider: QLPreviewProvider, QLPreviewingController {
  func providePreview(for request: QLFilePreviewRequest) async throws -> QLPreviewReply {
    guard
      let library = Bundle(for: PreviewProvider.self).url(
        forResource: "editor-libs", withExtension: "js", subdirectory: "vendor")
    else { throw CocoaError(.fileNoSuchFile) }
    let file = request.fileURL
    return QLPreviewReply(dataOfContentType: .html, contentSize: CGSize(width: 820, height: 720)) {
      reply in
      reply.stringEncoding = .utf8
      return try PreviewRenderer.render(url: file, library: library) { fonts in
        let fontType = UTType(mimeType: "font/woff2") ?? .font
        reply.attachments = fonts.mapValues { QLPreviewReplyAttachment(data: $0, contentType: fontType) }
      }
    }
  }
}
