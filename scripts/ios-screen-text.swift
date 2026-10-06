// OCR of screenshots from disposable iPhone and iPad test simulators.
// https://developer.apple.com/documentation/vision/vnrecognizetextrequest
import Foundation
import ImageIO
import Vision

guard CommandLine.arguments.count == 2 else {
    fputs("Usage: ios-screen-text <screenshot.png>\n", stderr)
    exit(2)
}

do {
    let request = VNRecognizeTextRequest()
    // Hosted runners may not provide a GPU usable by Vision.
    request.usesCPUOnly = true
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hant", "en-US"]
    request.usesLanguageCorrection = false
    // A full 13-inch iPad capture (2064 x 2752) took over 45 seconds on the
    // runner's CPU. The page's labels stay legible at a third of the pixels.
    let url = URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL
    guard
        let source = CGImageSourceCreateWithURL(url, nil),
        let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: 1600,
        ] as CFDictionary)
    else {
        fputs("Screenshot recognition failed: unreadable image\n", stderr)
        exit(1)
    }
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    try handler.perform([request])
    let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
    let data = try JSONSerialization.data(withJSONObject: text)
    print(String(decoding: data, as: UTF8.self))
} catch {
    fputs("Screenshot recognition failed: \(error)\n", stderr)
    exit(1)
}
