import Foundation
import CryptoKit
// Provision a separate publisher identity once. Only the public half belongs in the application.
umask(0o077)
guard CommandLine.arguments.count == 2 else {
  FileHandle.standardError.write(Data("Usage: swift new-key.swift <private-key-path>\n".utf8))
  exit(2)
}
let keyFile = URL(fileURLWithPath: CommandLine.arguments[1])
let fm = FileManager.default
let signer: Curve25519.Signing.PrivateKey
if fm.fileExists(atPath: keyFile.path) {
  guard let seed = Data(base64Encoded: try Data(contentsOf: keyFile)), seed.count == 32 else {
    FileHandle.standardError.write(Data("Invalid Ed25519 publisher key.\n".utf8))
    exit(1)
  }
  signer = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
} else {
  try fm.createDirectory(at: keyFile.deletingLastPathComponent(), withIntermediateDirectories: true)
  signer = Curve25519.Signing.PrivateKey()
  try signer.rawRepresentation.base64EncodedData().write(to: keyFile, options: .withoutOverwriting)
}
print(signer.publicKey.rawRepresentation.base64EncodedString())
