import Foundation
import JavaScriptCore

// Exercise the same standalone JSContext as Quick Look with the Monterey-era API surface.
let legacy = JSContext()!
legacy.evaluateScript("delete Array.prototype.at; delete String.prototype.at; delete Object.hasOwn; delete globalThis.structuredClone")
let libraries = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
legacy.evaluateScript(libraries)
precondition(legacy.exception == nil, legacy.exception?.toString() ?? "Could not load the editor libraries")
let compatible = legacy.evaluateScript("""
  (() => {
    const original = new Map([['row', ['one', 'two']]]);
    const copy = structuredClone(original);
    copy.get('row')[0] = 'new';
    return original.get('row')[0] === 'one' && copy.get('row').at(-1) === 'two'
      && 'Samare'.at(-1) === 'e' && Object.hasOwn({note: 1}, 'note')
      && SamareEditorLibs.marked.parse('[doc][link]\\n\\n[link]: example.md').includes('href="example.md"');
  })()
  """)
precondition(legacy.exception == nil && compatible?.toBool() == true, "Monterey editor library compatibility")

// This program lives in the native extension, outside the JavaScript vendor build.
// A literal lookbehind anywhere in it prevents even a plain heading from rendering on Monterey.
for assertion in ["(?<=", "(?<!"] {
  precondition(!PreviewRenderer.markdownScript.contains(assertion),
               "Quick Look's embedded program requires a JavaScript RegExp lookbehind")
}

let fixture = FileManager.default.temporaryDirectory.appendingPathComponent(
  "samare-ql-" + UUID().uuidString + ".md")
try Data(
  "# Preview test\n\n| A | B |\n|---|---|\n| 1 | **two** |\n\nInline $x^2$.\n\n```js\nconst n = 4;\n```\n\n<script>alert('x')</script>\n"
    .utf8
).write(to: fixture)
defer { try? FileManager.default.removeItem(at: fixture) }
var fonts = [String: Data]()
let html = String(
  decoding: try PreviewRenderer.render(
    url: fixture, library: URL(fileURLWithPath: CommandLine.arguments[1])) { fonts = $0 }, as: UTF8.self)
precondition(
  html.contains("<h1>Preview test</h1>") && html.contains("<table>")
    && html.contains("<strong>two</strong>") && !html.contains("<script>")
    && html.contains("<msup>") && html.contains("<span class=\"token keyword\">")
    && html.contains("data-language-label=\"JavaScript\"") && html.contains("katex-html"))
precondition(fonts.count == 26 && fonts["geist-mono-latin-wght-normal.woff2"] != nil)
precondition(fonts.allSatisfy { name, data in
  data.starts(with: Data("wOF2".utf8)) && html.contains("url(cid:" + name + ")")
})
precondition(html.contains("font-src cid:") && !html.contains("url(fonts/") && !html.contains("url(./fonts/"))
let library = URL(fileURLWithPath: CommandLine.arguments[1])
func markup(_ url: URL) throws -> String {
  let rendered = try PreviewRenderer.render(url: url, library: library)
  return String(decoding: rendered, as: UTF8.self).components(separatedBy: "<body>")[1]
}
let sample = try markup(URL(fileURLWithPath: "Samples/Workspace.md"))
let titleRange = sample.range(of: "<h1>Field notes</h1>")!
let propertiesRange = sample.range(of: "<dl class=\"properties\">")!
precondition(titleRange.upperBound <= propertiesRange.lowerBound && propertiesRange.lowerBound < sample.range(of: "<p>")!.lowerBound)
precondition(sample.contains("<dt>status</dt><dd>Draft</dd>") && sample.contains("<dt>tags</dt><dd>writing, local</dd>"))
precondition(sample.contains("<span class=\"wikilink\">reading list</span>") && !sample.contains("[[Notes/Reading list|"))
precondition(sample.contains("<li class=\"task done\"><input checked") && sample.contains("<li class=\"task\"><input disabled"))

try Data("\u{FEFF}---\r\ntags:\r\n  - red\r\n  - blue\r\nnested: {score: 2}\r\n---\r\nText \u{60}[[literal]]\u{60} with [[plain]].\r\n".utf8).write(to: fixture)
let complex = try markup(fixture)
precondition(complex.hasPrefix("<article><dl") && complex.contains("<dd>red, blue</dd>")
  && complex.contains("<dd>{&quot;score&quot;:2}</dd>") && complex.contains("<code>[[literal]]</code>")
  && complex.contains("<span class=\"wikilink\">plain</span>"))
try Data("---\nbroken: [<img>,\n---\n# Kept\n".utf8).write(to: fixture)
let invalid = try markup(fixture)
precondition(invalid.contains("<pre class=\"raw-properties\">---\nbroken: [&lt;img&gt;,\n---\n</pre>")
  && invalid.contains("<h1>Kept</h1>"))
try Data("---\na: unfinished\n".utf8).write(to: fixture)
let unclosed = try markup(fixture)
precondition(unclosed.contains("<pre class=\"raw-properties\">---\na: unfinished\n</pre>"))
print(
  "Quick Look preview rendered GFM, math, highlighting, 26 WOFF2s, bundled Workspace.md properties and wiki aliases; malformed YAML stays visible"
)

let flow = "flowchart LR\nA-->B-->C-->D-->E-->F-->G-->H-->I-->J-->K-->L"
let pie = "pie\n  \"Item one\" : 67\n  \"Item two\" : 33"
func diagram(_ source: String) -> String { "```mermaid\n" + source + "\n```\n\n" }
func writeAndRender(_ text: String) throws -> String {
  try Data(text.utf8).write(to: fixture)
  return try markup(fixture)
}
let price = try writeAndRender("从**$19mn**到**$172mn**。此外 $x+y$。")
precondition(price.contains("<strong>$19mn</strong>") && price.contains("<strong>$172mn</strong>") && price.contains("katex-mathml"))
let delimiters = try writeAndRender(#"""
  Single $x$ and escaped dollar $a\$b$.

  Trailing space $x $.

  Escaped trailing space $x\ $.

  Dollar followed by a digit $x$2.
  """#)
precondition(delimiters.components(separatedBy: #"<span class="inlinemath">"#).count == 3)
precondition(delimiters.contains(#"<annotation encoding="application/x-tex">a\$b</annotation>"#))
precondition(delimiters.contains("$x $.") && delimiters.contains(#"$x\ $."#) && delimiters.contains("$x$2."))
let diagrams = try writeAndRender("# Figures\n\n" + diagram(flow) + diagram(pie) + diagram("invalid source"))
precondition(diagrams.contains("class=\"pele pele-flowchart\"") && diagrams.contains("class=\"pele pele-pie\"")
  && diagrams.contains("class=\"pele-slices\"") && diagrams.contains("Item two")
  && diagrams.contains("<pre data-language-label=\"mermaid\"><code>invalid source</code></pre>"))
precondition(!diagrams.contains("<script") && !diagrams.contains("src=\"http"))
let bounds = try NSRegularExpression(pattern: #"viewBox="0 0 ([.\d]+) ([.\d]+)""#)
let svg = diagrams as NSString
let rect = bounds.firstMatch(in: diagrams, range: NSRange(location: 0, length: svg.length))!
precondition(Double(svg.substring(with: rect.range(at: 2)))! > 3 * Double(svg.substring(with: rect.range(at: 1)))!)
let notice = "<p class=\"ql-rest\">Open in Samare to read the rest.</p>"
let twentyFour = String(repeating: diagram("graph LR\na-->b"), count: 24)
let atCount = try writeAndRender(twentyFour)
let overCount = try writeAndRender(twentyFour + diagram("graph LR\nLAST-->OMITTED") + "Tail.")
precondition(atCount.components(separatedBy: "pele-flowchart").count == 25 && !atCount.contains(notice))
precondition(overCount.components(separatedBy: "pele-flowchart").count == 25 && overCount.contains(notice) && !overCount.contains("OMITTED"))
let note = "# First\n\n" + String(repeating: "🗒", count: 99_980) + "\n\n"
let short = try writeAndRender(note + "End.")
let long = try writeAndRender(note + String(repeating: "后", count: 80) + "\n\nTail.")
precondition(short.contains("End.") && !short.contains(notice))
precondition(long.contains("<h1>First</h1>") && long.contains(notice) && !long.contains("后") && !long.contains("Tail."))
let huge = try writeAndRender("# Start\n\n" + String(repeating: "x", count: 2_000_000) + "\n\nEnd.")
precondition(huge.contains(notice) && !huge.contains("End.") && huge.count < 1000)
let unsafe = try writeAndRender(diagram("graph LR\na[\"<script>bad()</script>\"]-->b\nclick b \"https://localhost/hidden\""))
precondition(!unsafe.contains("<script>") && !unsafe.contains("href=\"https://localhost"))
print("Quick Look rendered offline vector flowchart and pie, folded the long LR chain, retained invalid source, bounded a 2 MB note, and matched UTF-16 / 24-diagram cutoffs")
