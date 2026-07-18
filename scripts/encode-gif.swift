import Foundation
import ImageIO
import UniformTypeIdentifiers

guard CommandLine.arguments.count == 4 else {
    fputs("Usage: encode-gif.swift <frames-directory> <output.gif> <frame-delay-seconds>\n", stderr)
    exit(64)
}

let framesDirectory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let outputURL = URL(fileURLWithPath: CommandLine.arguments[2])
guard let frameDelay = Double(CommandLine.arguments[3]), frameDelay > 0 else {
    fputs("Frame delay must be a positive number.\n", stderr)
    exit(64)
}

let fileManager = FileManager.default
let frameURLs = try fileManager.contentsOfDirectory(
    at: framesDirectory,
    includingPropertiesForKeys: nil,
    options: [.skipsHiddenFiles]
)
.filter { $0.pathExtension.lowercased() == "png" }
.sorted { $0.lastPathComponent < $1.lastPathComponent }

guard !frameURLs.isEmpty else {
    fputs("No PNG frames found in \(framesDirectory.path).\n", stderr)
    exit(66)
}

try? fileManager.removeItem(at: outputURL)
guard let destination = CGImageDestinationCreateWithURL(
    outputURL as CFURL,
    UTType.gif.identifier as CFString,
    frameURLs.count,
    nil
) else {
    fputs("Could not create GIF destination.\n", stderr)
    exit(73)
}

let animationProperties: CFDictionary = [
    kCGImagePropertyGIFDictionary: [
        kCGImagePropertyGIFLoopCount: 0
    ]
] as CFDictionary
CGImageDestinationSetProperties(destination, animationProperties)

let frameProperties: CFDictionary = [
    kCGImagePropertyGIFDictionary: [
        kCGImagePropertyGIFDelayTime: frameDelay,
        kCGImagePropertyGIFUnclampedDelayTime: frameDelay
    ]
] as CFDictionary

for frameURL in frameURLs {
    guard
        let source = CGImageSourceCreateWithURL(frameURL as CFURL, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else {
        fputs("Could not decode \(frameURL.lastPathComponent).\n", stderr)
        exit(65)
    }
    CGImageDestinationAddImage(destination, image, frameProperties)
}

guard CGImageDestinationFinalize(destination) else {
    fputs("Could not finalize GIF.\n", stderr)
    exit(74)
}

print("Encoded \(frameURLs.count) frames to \(outputURL.path)")
