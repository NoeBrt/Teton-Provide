// Run on macOS: swift desktop/make-icons.swift. The iOS source is read, never rewritten.
import AppKit

let desktop = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let source = desktop.deletingLastPathComponent().appendingPathComponent("assets/icon.png")
let output = desktop.appendingPathComponent("src-tauri/icons")
let image = try NSBitmapImageRep(data: Data(contentsOf: source))!
precondition(image.pixelsWide == 1024 && image.pixelsHigh == 1024)
let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!

func canvas(_ size: Int) -> CGContext {
    CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size * 4,
              space: colorSpace, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
}

let master = canvas(1024)
let shape = CGMutablePath()
// 824 px of artwork in a 1024 px canvas: optical Dock size, with continuous squircle corners.
for step in 0...1024 {
    let angle = Double(step) * .pi / 512
    let x = cos(angle), y = sin(angle)
    let point = CGPoint(x: 512 + 412 * copysign(pow(abs(x), 0.4), x),
                        y: 512 + 412 * copysign(pow(abs(y), 0.4), y))
    if step == 0 { shape.move(to: point) } else { shape.addLine(to: point) }
}
shape.closeSubpath()
master.addPath(shape)
master.clip()
master.interpolationQuality = .high
master.draw(image.cgImage!, in: CGRect(x: 100, y: 100, width: 824, height: 824))
let artwork = master.makeImage()!

func save(_ size: Int, to url: URL) throws {
    let context = canvas(size)
    context.interpolationQuality = .high
    context.draw(artwork, in: CGRect(x: 0, y: 0, width: size, height: size))
    let bitmap = NSBitmapImageRep(cgImage: context.makeImage()!)
    // A square white background would fail this check, including at the smallest Dock sizes.
    precondition(bitmap.colorAt(x: 0, y: 0)!.alphaComponent == 0)
    precondition(bitmap.colorAt(x: size / 2, y: size / 2)!.alphaComponent == 1)
    try bitmap.representation(using: .png, properties: [:])!.write(to: url)
}

for (name, size) in [("icon.png", 1024), ("32x32.png", 32), ("128x128.png", 128), ("128x128@2x.png", 256)] {
    try save(size, to: output.appendingPathComponent(name))
}
let iconset = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".iconset")
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: false)
defer { try? FileManager.default.removeItem(at: iconset) }
for size in [16, 32, 128, 256, 512] {
    try save(size, to: iconset.appendingPathComponent("icon_\(size)x\(size).png"))
    try save(size * 2, to: iconset.appendingPathComponent("icon_\(size)x\(size)@2x.png"))
}
let tool = Process()
tool.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
tool.arguments = ["-c", "icns", iconset.path, "-o", output.appendingPathComponent("icon.icns").path]
try tool.run()
tool.waitUntilExit()
precondition(tool.terminationStatus == 0)
print("PASS: desktop PNGs and icon.icns regenerated from assets/icon.png; transparent corners checked")

// Native menu-bar template: the app icon's dot inside a ring, with no square background.
let tray = canvas(36)
tray.setFillColor(NSColor.black.cgColor)
tray.setStrokeColor(NSColor.black.cgColor)
tray.setLineWidth(3)
tray.strokeEllipse(in: CGRect(x: 4, y: 4, width: 28, height: 28))
tray.fillEllipse(in: CGRect(x: 10, y: 10, width: 16, height: 16))
let template = NSBitmapImageRep(cgImage: tray.makeImage()!)
precondition(template.colorAt(x: 0, y: 0)!.alphaComponent == 0)
try template.representation(using: .png, properties: [:])!.write(to: output.appendingPathComponent("menu-bar.png"))
print("PASS: transparent menu-bar template generated")
