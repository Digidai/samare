import Foundation

let args = Array(CommandLine.arguments.dropFirst())
guard [3, 5].contains(args.count) else {
  fputs("usage: native-save-fixture FILE BASE NEW [READY GATE]\n", stderr)
  exit(1)
}
do {
  var store = DocumentStore()
  let file = try store.grantFile(DocumentStore.canonical(args[0]))
  if args.count == 5 {
    try Data().write(to: URL(fileURLWithPath: args[3]))
    let limit = Date(timeIntervalSinceNow: 20)
    while !FileManager.default.fileExists(atPath: args[4]) {
      guard Date() < limit else { throw HostError("Timed out waiting for save barrier.") }
      Thread.sleep(forTimeInterval: 0.001)
    }
  }
  switch try store.write(args[2], to: file, replacing: args[1]) {
  case .saved: exit(0)
  case .conflict: exit(2)
  }
} catch {
  fputs(error.localizedDescription + "\n", stderr)
  exit(1)
}
