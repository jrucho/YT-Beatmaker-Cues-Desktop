import AppKit
import Foundation

guard CommandLine.arguments.count == 3,
      let original = NSImage(contentsOfFile: CommandLine.arguments[1]) else {
    fatalError("Usage: make_icon.swift original.png output.png")
}
let size = NSSize(width: 1024, height: 1024)
let image = NSImage(size: size)
image.lockFocus()
NSColor(calibratedRed: 10/255, green: 12/255, blue: 14/255, alpha: 1).setFill()
NSRect(origin: .zero, size: size).fill()
original.draw(in: NSRect(x: 0, y: 88, width: 1024, height: 1024), from: .zero, operation: .sourceOver, fraction: 1)
let label = "PLUGIN" as NSString
let attributes: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: 67, weight: .semibold),
    .foregroundColor: NSColor(calibratedRed: 202/255, green: 239/255, blue: 79/255, alpha: 1),
    .kern: 9
]
let textSize = label.size(withAttributes: attributes)
label.draw(at: NSPoint(x: (1024 - textSize.width) / 2, y: 142), withAttributes: attributes)
image.unlockFocus()
guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
      let png = bitmap.representation(using: .png, properties: [:]) else { fatalError("PNG encoding failed") }
let destination = URL(fileURLWithPath: CommandLine.arguments[2])
try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
try png.write(to: destination)
