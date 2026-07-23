import Foundation
import AVFoundation
import CoreMedia

let srcPath = CommandLine.arguments[1]
let dstPath = CommandLine.arguments[2]
let src = URL(fileURLWithPath: srcPath)
let dst = URL(fileURLWithPath: dstPath)

let sem = DispatchSemaphore(value: 0)
var fail: String?
var pcmData = Data()
var sampleRate = 44100
var channels = 2

Task {
  do {
    let asset = AVURLAsset(url: src)
    let tracks = try await asset.loadTracks(withMediaType: .audio)
    guard let track = tracks.first else { throw NSError(domain: "decode", code: 1, userInfo: [NSLocalizedDescriptionKey: "no audio"]) }
    let reader = try AVAssetReader(asset: asset)
    let settings: [String: Any] = [
      AVFormatIDKey: Int(kAudioFormatLinearPCM),
      AVLinearPCMBitDepthKey: 16,
      AVLinearPCMIsBigEndianKey: false,
      AVLinearPCMIsFloatKey: false,
      AVLinearPCMIsNonInterleaved: false
    ]
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
    output.alwaysCopiesSampleData = true
    reader.add(output)
    guard reader.startReading() else { throw reader.error ?? NSError(domain: "decode", code: 2) }
    while let sample = output.copyNextSampleBuffer() {
      guard let block = CMSampleBufferGetDataBuffer(sample) else { continue }
      var length = 0
      var dataPointer: UnsafeMutablePointer<Int8>?
      let status = CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &dataPointer)
      if status == kCMBlockBufferNoErr, let dataPointer = dataPointer, length > 0 {
        pcmData.append(Data(bytes: dataPointer, count: length))
      }
    }
    if reader.status == .failed {
      throw reader.error ?? NSError(domain: "decode", code: 3)
    }
    // Infer channels/rate from format description if possible
    if let desc = track.formatDescriptions.first {
      let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(desc as! CMAudioFormatDescription)?.pointee
      if let asbd = asbd {
        sampleRate = Int(asbd.mSampleRate)
        channels = Int(asbd.mChannelsPerFrame)
      }
    }
  } catch {
    fail = String(describing: error)
  }
  sem.signal()
}

_ = sem.wait(timeout: .now() + 30)
if let fail = fail {
  fputs("FAIL: \(fail)\n", stderr)
  exit(1)
}
if pcmData.isEmpty {
  fputs("FAIL: empty pcm\n", stderr)
  exit(1)
}

func writeWav(url: URL, pcm: Data, channels: Int, rate: Int) throws {
  let dataSize = UInt32(pcm.count)
  var h = Data()
  func s(_ x: String) { h.append(contentsOf: x.utf8) }
  func u32(_ v: UInt32) { var x = v.littleEndian; withUnsafeBytes(of: &x) { h.append(contentsOf: $0) } }
  func u16(_ v: UInt16) { var x = v.littleEndian; withUnsafeBytes(of: &x) { h.append(contentsOf: $0) } }
  s("RIFF"); u32(36 &+ dataSize); s("WAVE")
  s("fmt "); u32(16); u16(1); u16(UInt16(channels))
  u32(UInt32(rate)); u32(UInt32(rate * channels * 2)); u16(UInt16(channels * 2)); u16(16)
  s("data"); u32(dataSize)
  try (h + pcm).write(to: url)
}

try writeWav(url: dst, pcm: pcmData, channels: channels, rate: sampleRate)
print("ok frames=\(pcmData.count/(2*channels)) rate=\(sampleRate) ch=\(channels) dur=\(Double(pcmData.count/(2*channels))/Double(sampleRate))")
