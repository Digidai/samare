import AppKit
import UniformTypeIdentifiers
import WebKit

let app = NSApplication.shared
let controller = SamareHost()
app.setActivationPolicy(.regular)
app.delegate = controller
app.run()
