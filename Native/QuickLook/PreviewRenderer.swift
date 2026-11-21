import Foundation
import CoreText
import JavaScriptCore
import UniformTypeIdentifiers

enum PreviewRenderer {
  // Quick Look resolves a CID only when the reply carries an attachment with the same name.
  private static func fontStyles(for library: URL, fonts: inout [String: Data]) throws -> String {
    let vendor = library.deletingLastPathComponent()
    let resources = vendor.deletingLastPathComponent()
    let woff2 = try NSRegularExpression(pattern: #"url\((?:\./)?fonts/([a-zA-Z0-9_-]+\.woff2)\)"#)
    var styles = ""
    for sheet in [resources.appendingPathComponent("typefaces.css"), vendor.appendingPathComponent("katex.min.css")] {
      var css = try String(contentsOf: sheet, encoding: .utf8)
      // The open-source KaTeX CSS also references obsolete WOFF/TTF versions. Only WOFF2 is packaged.
      css = css.replacingOccurrences(
        of: #",url\(fonts/[a-zA-Z0-9_-]+\.(?:woff|ttf)\) format\("(?:woff|truetype)"\)"#,
        with: "", options: .regularExpression)
      let text = css as NSString
      let output = NSMutableString(string: css)
      for hit in woff2.matches(in: css, range: NSRange(location: 0, length: text.length)).reversed() {
        let name = text.substring(with: hit.range(at: 1))
        let file = sheet.deletingLastPathComponent().appendingPathComponent("fonts").appendingPathComponent(name)
        fonts[name] = try Data(contentsOf: file)
        output.replaceCharacters(in: hit.range, with: "url(cid:\(name))")
      }
      styles += (output as String) + "\n"
    }
    return styles
  }

  // Keep I/O bounded even when Finder asks to preview a multi-gigabyte note. The
  // parser counts UTF-16 units and accepts up to 4,000 extra units to finish its last block.
  private static func readPrefix(_ url: URL) throws -> (String, Bool) {
    let limit = (200_000 + 4_000) * 4 + 32_768
    let file = try FileHandle(forReadingFrom: url)
    defer { try? file.close() }
    var data = Data()
    while data.count <= limit {
      guard let chunk = try file.read(upToCount: limit + 1 - data.count), !chunk.isEmpty else { break }
      data.append(chunk)
    }
    if data.count > limit {
      return (String(decoding: data.prefix(limit), as: UTF8.self), true)
    }
    guard let text = String(data: data, encoding: .utf8) else { throw CocoaError(.fileReadInapplicableStringEncoding) }
    return (text, false)
  }

  private static func diagramMeasurer(_ resources: URL) -> @convention(block) (String, Double, Int) -> Double {
    // These are the bundled variable-font instances. No system-wide font registration is needed.
    func faces(_ file: String) -> [CTFontDescriptor] {
      let url = resources.appendingPathComponent("fonts/" + file)
      return CTFontManagerCreateFontDescriptorsFromURL(url as CFURL) as? [CTFontDescriptor] ?? []
    }
    let sans = faces("geist-latin-wght-normal.woff2"), mono = faces("geist-mono-latin-wght-normal.woff2")
    var cache: [String: CTFont] = [:]
    return { text, size, style in
      let key = "\(size)/\(style)"
      let font: CTFont
      if let cached = cache[key] { font = cached } else {
        let choices = style & 4 != 0 ? mono : sans
        let weight = style & 1 != 0 ? "-Bold" : "-Regular"
        let descriptor = choices.first {
          let name = CTFontDescriptorCopyAttribute($0, kCTFontNameAttribute) as? String
          return name?.hasSuffix(weight) == true
        }
        let points = style & 24 == 0 ? size : size / 1.2
        let base = descriptor.map { CTFontCreateWithFontDescriptor($0, points, nil) }
          ?? CTFontCreateWithName("Helvetica" as CFString, points, nil)
        font = style & 2 == 0 ? base : CTFontCreateCopyWithSymbolicTraits(base, 0, nil, .italicTrait, .italicTrait) ?? base
        cache[key] = font
      }
      let value = NSAttributedString(string: text, attributes: [.init(kCTFontAttributeName as String): font])
      return CTLineGetTypographicBounds(CTLineCreateWithAttributedString(value), nil, nil, nil)
    }
  }

  static func render(url: URL, library: URL, attachFonts: ([String: Data]) -> Void = { _ in }) throws -> Data {
    let (text, sourceWasClipped) = try readPrefix(url)
    let parser = try String(contentsOf: library, encoding: .utf8)
    guard let js = JSContext() else { throw NSError(domain: "Preview", code: 1) }
    if text.hasPrefix("---") || text.hasPrefix("\u{FEFF}---") {
      let yaml = library.deletingLastPathComponent().appendingPathComponent("js-yaml.min.js")
      js.evaluateScript(try String(contentsOf: yaml, encoding: .utf8))
    }
    js.evaluateScript(parser)
    let vendor = library.deletingLastPathComponent()
    let resources = vendor.deletingLastPathComponent()
    var diagramStyles = ""
    if text.contains("mermaid") {
      js.evaluateScript(try String(contentsOf: vendor.appendingPathComponent("pele.global.js"), encoding: .utf8))
      js.evaluateScript(try String(contentsOf: resources.appendingPathComponent("diagram.js"), encoding: .utf8))
      diagramStyles = js.evaluateScript("SamareDiagrams.styles")?.toString() ?? ""
      js.setObject(diagramMeasurer(resources), forKeyedSubscript: "diagramTextWidth" as NSString)
    }
    js.setObject(sourceWasClipped, forKeyedSubscript: "sourceWasClipped" as NSString)
    let root = url.deletingLastPathComponent().standardizedFileURL.resolvingSymlinksInPath()
    var remaining = 12 * 1024 * 1024
    let imageData: @convention(block) (String) -> String = { raw in
      guard let reference = raw.removingPercentEncoding, !reference.hasPrefix("/"),
        URL(string: reference)?.scheme == nil
      else { return "" }
      let file = root.appendingPathComponent(reference).standardizedFileURL
        .resolvingSymlinksInPath()
      guard file.pathComponents.starts(with: root.pathComponents),
        ["jpg", "jpeg", "png", "gif", "webp", "avif"].contains(file.pathExtension.lowercased()),
        let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= remaining,
        let mime = UTType(filenameExtension: file.pathExtension)?.preferredMIMEType,
        let data = try? Data(contentsOf: file), data.count <= remaining
      else { return "" }
      remaining -= data.count
      return "data:" + mime + ";base64," + data.base64EncodedString()
    }
    js.setObject(imageData, forKeyedSubscript: "imageData" as NSString)
    js.setObject(text, forKeyedSubscript: "sourceText" as NSString)
    let value = js.evaluateScript(
      #"""
      (() => {
        const escape = s => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
        function documentParts(source) {
          if (!/^\uFEFF?---[ \t]*\r?\n/.test(source)) return {body: source};
          const header = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(source);
          const raw = text => '<pre class="raw-properties">'+escape(text)+'</pre>';
          if (!header || header.index !== 0) {
            const unclosed = /^\uFEFF?---[ \t]*\r?\n(?:[ \t]*#[^\n]*\n)*[^\s#\n][^:\n]*:(?:[ \t]|\r?$)/m.exec(source);
            if (unclosed?.index === 0) return {body: '', before: raw(source)};
            return {body: source};
          }
          if (header[1].length === 0) return {body: source};
          const body = source.slice(header[0].length);
          try {
            const values = jsyaml.load(header[1], {schema: jsyaml.CORE_SCHEMA});
            if (values == null || typeof values !== 'object' || Array.isArray(values)) {
              return {body, before: raw(header[0])};
            }
            // A YAML alias can refer back to itself or share a nested collection.
            let remaining = Math.max(1024, header[1].length * 4);
            function display(value) {
              if (typeof value !== 'object' || value === null) return String(value ?? '');
              return JSON.stringify(value, (_, item) => {
                if (--remaining < 0) throw new Error('No compact property representation');
                return item;
              });
            }
            const rows = Object.entries(values).filter(([, value]) => value !== null).map(([key, value]) => {
              const label = Array.isArray(value) ? value.map(display).join(', ') : display(value);
              return '<div><dt>'+escape(key)+'</dt><dd>'+escape(label)+'</dd></div>';
            });
            return {body, properties: rows.length ? '<dl class="properties">'+rows.join('')+'</dl>' : ''};
          } catch {
            return {body, before: raw(header[0])};
          }
        }
        const {marked,markedCjkFriendly,hljs,katex} = SamareEditorLibs;
        marked.use(markedCjkFriendly());
        const math = (token, displayMode) => katex.renderToString(token.text,{displayMode,output:'htmlAndMathml',throwOnError:false,trust:false});
        marked.use({extensions:[
          {name:'wikilink', level:'inline', start: s => s.indexOf('[['), tokenizer(s) {
            const match = /^\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/.exec(s);
            if (match) return {type:'wikilink',raw:match[0],text:match[2] || match[1]};
          }, renderer: token => '<span class="wikilink">'+escape(token.text)+'</span>'},
          {name:'displaymath',level:'block',start:s=>s.indexOf('$$'),tokenizer(s){const m=/^\$\$[ \t]*\n([\s\S]+?)\n\$\$[ \t]*(?=\n|$)/.exec(s); if(m)return {type:'displaymath',raw:m[0],text:m[1]}},renderer:t=>'<div class="displaymath">'+math(t,true)+'</div>'},
          {name:'inlinemath',level:'inline',start:s=>s.indexOf('$'),tokenizer(s){const m=/^\$(?![\s$])((?:\\.|[^$\n])+?)(?<!\s)\$(?!\d)/.exec(s); if(m)return {type:'inlinemath',raw:m[0],text:m[1]}},renderer:t=>'<span class="inlinemath">'+math(t,false)+'</span>'}
        ]});
        const renderer = new marked.Renderer();
        renderer.listitem = function(token) {
          const item = marked.Renderer.prototype.listitem.call(this, token);
          return token.task ? item.replace(/^<li>/, '<li class="task'+(token.checked ? ' done' : '')+'">') : item;
        };
        let diagrams = 0;
        renderer.code = function(token) {
          const lang = (token.lang || '').split(/\s+/)[0];
          if (lang === 'mermaid') {
            ++diagrams;
            try {
              const {svg} = SamareDiagrams.render(token.text, 624, {width:diagramTextWidth});
              return '<div class="samare-diagram">'+svg+'</div>';
            } catch { /* Preserve the readable source if a diagram cannot be drawn. */ }
          }
          const known = lang && hljs.getLanguage(lang);
          const grammar = Object.hasOwn(SamareScriptGrammar.languages, lang.toLowerCase()) && SamareScriptGrammar.languages[lang.toLowerCase()];
          let contents = escape(token.text);
          if (grammar && typeof grammar === 'object') contents = SamareScriptGrammar.highlight(token.text,grammar,lang);
          else if (known && !/^(jsx|tsx)$/i.test(lang)) contents = hljs.highlight(token.text,{language:lang,ignoreIllegals:true}).value;
          const title = (known?.name || lang).replace(/^(Java|Type)script$/, '$1Script');
          const label = lang ? ' data-language-label="'+escape(title)+'"' : '';
          return '<pre'+label+'><code>'+contents+'</code></pre>';
        };
        renderer.html = token => escape(token.text);
        renderer.image = token => { const data = imageData(token.href); return data ? '<img src="' + data + '" alt="' + escape(token.text || '') + '">' : escape(token.text || ''); };
        renderer.link = function(token) {
          const inner = this.parser.parseInline(token.tokens);
          return /^(?:https?:\/\/|mailto:|#)/i.test(token.href) ? '<a href="' + escape(token.href) + '">' + inner + '</a>' : inner;
        };
        const parts = documentParts(sourceText);
        const limit = 200000, input = parts.body.slice(0, limit + 4000);
        const options = {...marked.defaults, renderer, gfm:true};
        const tokens = new marked.Lexer(options).lex(input);
        const parser = new marked.Parser(options);
        let offset = 0, content = '', clipped = sourceWasClipped || input.length < parts.body.length;
        for (const token of tokens) {
          const end = offset + token.raw.trimEnd().length;
          offset += token.raw.length;
          if (token.type === 'space') continue;
          if (content && (end > limit || diagrams >= 24)) { clipped = true; break; }
          content += parser.parse([token]);
        }
        if (clipped) content += '<p class="ql-rest">Open in Samare to read the rest.</p>';
        if (parts.before || !parts.properties) return (parts.before || '') + content;
        const title = /^<h1>[\s\S]*?<\/h1>\n?/.exec(content);
        if (!title) return parts.properties + content;
        return title[0] + parts.properties + content.slice(title[0].length);
      })()
      """#)
    guard js.exception == nil, let body = value?.toString(), !body.isEmpty || text.isEmpty else {
      throw NSError(
        domain: "Preview", code: 2,
        userInfo: [NSLocalizedDescriptionKey: "Unable to render Markdown preview."])
    }
    var fonts = [String: Data]()
    let sheets = try fontStyles(for: library, fonts: &fonts)
    let html = """
      <!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src cid:; img-src data:">
      <style>\(sheets)\n\(layout)\n\(diagramStyles)</style></head><body><article>\(body)</article></body></html>
      """
    attachFonts(fonts)
    return Data(html.utf8)
  }

  private static let layout = """
    :root {
      color-scheme: light dark;
      --paper: #fafafa; --panel: #f4f4f5; --ink: #1e1e22; --heading: #1e1e22; --secondary: #52525b; --tertiary: rgb(24 24 27 / 55%);
      --line: rgb(24 24 27 / 8%); --rail: rgb(17 92 221 / 32%); --link: #115cdd;
      --keyword: #b0306a; --string: #2c7449; --number: #a4561f; --comment: #67676f; --function: #6b44c2; --type: #1f7389; --rule: rgb(24 24 27 / 20%);
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --paper: #08090b; --panel: #18181b; --ink: #e4e4e7; --heading: #fafafa; --secondary: #a1a1aa; --tertiary: rgb(244 244 245 / 45%);
        --line: rgb(255 255 255 / 10%); --rail: rgb(82 139 232 / 42%); --link: #6e9ce6;
        --keyword: #f07aa8; --string: #7bc995; --number: #e59a66; --comment: #8a8a93; --function: #b79cf5; --type: #6cc4d6; --rule: rgb(255 255 255 / 24%);
      }
    }
    html { background: var(--paper); text-rendering: optimizeLegibility }
    body { margin: 0; font: 400 17px/1.5 var(--samare-font-sans); font-kerning: normal; color: var(--ink) }
    article { box-sizing: border-box; max-width: 720px; margin: auto; padding: 56px 48px 72px; overflow-wrap: break-word }
    article > :first-child { margin-top: 0 }
    h1, h2, h3, h4 { line-height: 1.2; color: var(--heading) }
    h1, h2, h3 { letter-spacing: -.015em }
    h1 { font-size: 28px; font-weight: 700; margin: 56px 0 16px }
    h2 { font-size: 22px; font-weight: 600; margin: 40px 0 12px }
    h3 { font-size: 18px; font-weight: 600; margin: 24px 0 8px }
    h4 { font-size: 17px; font-weight: 700; margin: 12px 0 6px }
    p { margin: 0 0 16px }
    .ql-rest { margin-top: 32px; font-size: 13px; color: var(--tertiary) }
    .properties { display: flex; flex-wrap: wrap; gap: 2px 16px; margin: -8px 0 24px; font-size: 13px; line-height: 1.3; color: var(--secondary) }
    .properties div { display: flex } .properties dt { margin: 0 5px 0 0; color: var(--tertiary) } .properties dd { margin: 0 }
    .raw-properties { white-space: pre-wrap } .wikilink { color: var(--link); text-decoration: underline dotted; text-underline-offset: 3px }
    pre, code { font-family: var(--samare-font-mono) }
    code { font-size: .9em; font-weight: 500; letter-spacing: -.005em; padding: .1em .35em; border-radius: 3px; background: color-mix(in srgb, var(--ink) 8%, transparent) }
    pre { font-size: 13px; line-height: 1.45; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; margin: 0 0 16px; padding: 16px; overflow-x: auto; tab-size: 2 }
    pre code { font-size: 14px; font-weight: 400; padding: 0; background: transparent }
    pre[data-language-label]::before { content: attr(data-language-label); float: right; margin: -2px -4px 0 12px; font: 400 10px/1.45 var(--samare-font-sans); letter-spacing: .06em; text-transform: uppercase; color: var(--secondary) }
    a { color: var(--link); text-decoration: none; pointer-events: none }
    blockquote { margin: 0 0 16px; padding-left: 12px; border-left: 2px solid var(--rail); color: var(--secondary) }
    blockquote p:last-child { margin-bottom: 0 }
    ul, ol { margin: 0 0 16px; padding-left: 0 }
    li { line-height: 1.4; margin-bottom: 4px }
    li:last-child { margin-bottom: 0 }
    li > ol, li > ul { margin: 4px 0 0 1.35em }
    li.task { position: relative; list-style: none; padding-left: 1.35em }
    li.task.done { color: var(--tertiary); text-decoration: line-through }
    .task > input, .task > p:first-child > input:first-child { appearance: none; position: absolute; left: .5px; top: calc(.7em - 8px); box-sizing: border-box; margin: 0; width: 16px; height: 16px; font: inherit; border: 1.5px solid var(--tertiary); border-radius: 4px }
    .task input:checked { border-color: var(--link); background: var(--link) }
    .task input:checked::after { content: ''; display: block; width: 4px; height: 8px; margin: 1px 0 0 4px; border: solid white; border-width: 0 1.75px 1.75px 0; transform: rotate(45deg) }
    table { border: 1px solid var(--line); border-spacing: 0; border-radius: 6px; width: 100%; font-size: 14px; line-height: 1.3; margin: 16px 0 24px; overflow: hidden }
    th, td { text-align: left; vertical-align: top; padding: 8px 16px; border-bottom: 1px solid var(--line) }
    th { background: var(--panel); color: var(--secondary); font-weight: 600 }
    th + th, td + td { border-left: 1px solid var(--line) } tbody tr:last-child td { border-bottom: 0 }
    img { display: block; margin: auto; max-width: 100%; height: auto; border-radius: 8px }
    hr { border: 0; height: 1px; background: var(--rule); margin: 40px 0 }
    .inlinemath { display: inline-block; vertical-align: middle; max-width: 100%; overflow-x: auto; overflow-y: hidden; padding-inline: .15em; scrollbar-width: none }
    .displaymath { width: fit-content; max-width: 100%; margin: 12px auto; overflow-x: auto }
    .inlinemath .katex, .displaymath .katex { font-size: 1em } .displaymath .katex-display { margin: 0; text-align: left }
    .hljs-keyword, .hljs-selector-tag { color: var(--keyword) } .hljs-string, .hljs-attr { color: var(--string) }
    .hljs-number, .hljs-literal { color: var(--number) } .hljs-comment { color: var(--comment) }
    .hljs-title, .hljs-function { color: var(--function) }
    .token:is(.keyword,.tag,.attr-name,.selector,.important,.atrule) { color: var(--keyword) }
    .token:is(.string,.char,.template-string,.attr-value,.regex) { color: var(--string) }
    .token:is(.number,.boolean,.constant) { color: var(--number) }
    .token:is(.comment,.prolog,.doctype,.cdata) { color: var(--comment); font-style: italic }
    .token:is(.function,.method) { color: var(--function) }
    .token:is(.class-name,.builtin,.type,.namespace) { color: var(--type) }
    .token.punctuation { color: var(--secondary) }
    .token:is(.operator,.entity,.url) { color: var(--ink) }
    .token.bold { font-weight: bold } .token.italic { font-style: italic }
    """
}
