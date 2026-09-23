import { test, expect, describe } from "bun:test";
import fs from "fs";
import path from "path";
import { unzipSync } from "fflate";
import { fastGetImageDimensions } from "./fast-dimensions";
import { gzipCompress } from "./gzip";
import { extractMetadataAndCleanBlob, extractMetadataFromContainerBytes } from "./video-decoder";
import { createZip } from "./zip";
import { formatWebVTTTimestamp, roundToMultipleOf2 } from "./encoder-core";

if (typeof ImageData === "undefined") {
  (globalThis as any).ImageData = class ImageData {
    data: Uint8ClampedArray;
    width: number;
    height: number;
    constructor(data: Uint8ClampedArray, width: number, height: number) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
}

describe("av1pack Round-Trip Verification", () => {
  test("createZip generates a valid PKZIP archive using fflate and round-trips via unzipSync", async () => {
    const testFiles = [
      { name: "file1.txt", data: new TextEncoder().encode("Hello, av1pack!") },
      { name: "images/photo.png", data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
    ];
    const zipBytes = await createZip(testFiles);
    expect(zipBytes.length).toBeGreaterThan(30);

    // Standard PKZIP local header signature 0x04034b50
    expect(zipBytes[0]).toBe(0x50);
    expect(zipBytes[1]).toBe(0x4b);
    expect(zipBytes[2]).toBe(0x03);
    expect(zipBytes[3]).toBe(0x04);

    // Round-trip decompression via fflate
    const unzipped = unzipSync(zipBytes);
    expect(new TextDecoder().decode(unzipped["file1.txt"])).toBe("Hello, av1pack!");
    expect(unzipped["images/photo.png"]).toEqual(testFiles[1]!.data);
  });

  test("Fast header dimension parser parses Wikipedia sample images and detects no alpha on JPEGs", async () => {
    const sampleDir = path.resolve(import.meta.dir, "../public/wikipedia-example");
    const samples = fs.readdirSync(sampleDir).filter((f) => f.endsWith(".jpg"));
    expect(samples.length).toBeGreaterThan(0);

    for (const filename of samples) {
      const filePath = path.join(sampleDir, filename);
      const buf = fs.readFileSync(filePath);
      const file = new File([buf], filename, { type: "image/jpeg" });
      const dims = await fastGetImageDimensions(file);
      expect(dims.width).toBeGreaterThan(0);
      expect(dims.height).toBeGreaterThan(0);
      expect(dims.hasAlpha).toBe(false);
    }
  });

  test("Fast header parser accurately identifies alpha in PNG headers", async () => {
    // Construct minimal 33-byte RGBA PNG header (ColorType 6 = RGBA)
    const rgbaPngHeader = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG Signature
      0x00, 0x00, 0x00, 0x0d,                         // IHDR length: 13
      0x49, 0x48, 0x44, 0x52,                         // "IHDR"
      0x00, 0x00, 0x07, 0x80,                         // Width: 1920
      0x00, 0x00, 0x04, 0x38,                         // Height: 1080
      0x08,                                           // Bit depth: 8
      0x06,                                           // ColorType: 6 (RGBA)
      0x00, 0x00, 0x00,
    ]);
    const fileRgba = new File([rgbaPngHeader], "test_alpha.png", { type: "image/png" });
    const dimsRgba = await fastGetImageDimensions(fileRgba);
    expect(dimsRgba.width).toBe(1920);
    expect(dimsRgba.height).toBe(1080);
    expect(dimsRgba.hasAlpha).toBe(true);

    // Minimal RGB PNG header (ColorType 2 = RGB)
    const rgbPngHeader = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x05, 0x00,                         // Width: 1280
      0x00, 0x00, 0x02, 0xd0,                         // Height: 720
      0x08,
      0x02,                                           // ColorType: 2 (RGB)
      0x00, 0x00, 0x00,
    ]);
    const fileRgb = new File([rgbPngHeader], "test_no_alpha.png", { type: "image/png" });
    const dimsRgb = await fastGetImageDimensions(fileRgb);
    expect(dimsRgb.width).toBe(1280);
    expect(dimsRgb.height).toBe(720);
    expect(dimsRgb.hasAlpha).toBe(false);
  });

  test("Metadata trailer packaging and extraction restores 100% data and clean video bytes", async () => {
    const mockVideoData = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04]);
    const mockMetadata = {
      "0": { filename: "aurora.jpg", width: 1920, height: 1080, has_alpha: false },
      "1": { filename: "canyon.png", width: 2400, height: 1600, has_alpha: true },
    };

    const metaJson = JSON.stringify(mockMetadata);
    const compressedMeta = await gzipCompress(new TextEncoder().encode(metaJson));
    const trailerMagic = new TextEncoder().encode("AV1PACK\0");
    const metaLenBuffer = new Uint8Array(4);
    new DataView(metaLenBuffer.buffer).setUint32(0, compressedMeta.length, true);

    const combined = new Uint8Array(
      mockVideoData.byteLength + compressedMeta.length + trailerMagic.length + 4,
    );
    combined.set(mockVideoData, 0);
    combined.set(compressedMeta, mockVideoData.byteLength);
    combined.set(trailerMagic, mockVideoData.byteLength + compressedMeta.length);
    combined.set(metaLenBuffer, mockVideoData.byteLength + compressedMeta.length + trailerMagic.length);

    const packedBlob = new Blob([combined.buffer]);
    const extracted = await extractMetadataAndCleanBlob(packedBlob);

    // Verify clean blob
    const extractedBuffer = new Uint8Array(await extracted.cleanBlob.arrayBuffer());
    expect(extractedBuffer.length).toBe(mockVideoData.length);
    for (let i = 0; i < mockVideoData.length; i++) {
      expect(extractedBuffer[i]).toBe(mockVideoData[i]);
    }

    // Verify metadata dictionary
    expect(extracted.metadata).toEqual(mockMetadata);
  });

  test("In-container WebVTT metadata extraction cleanly restores all frame metadata from container", async () => {
    // Simulate a video file that has embedded WebVTT subtitle chunks but NO trailer at the end
    const frame0 = JSON.stringify({ filename: "img0.jpg", width: 1920, height: 1080, has_alpha: false });
    const frame1 = JSON.stringify({ filename: "img1.png", width: 2048, height: 1536, has_alpha: true });

    const encoder = new TextEncoder();
    const mockContainer = new Uint8Array([
      ...encoder.encode("EBML_MOCK_HEADER..."),
      ...encoder.encode(`SUBTITLE_BLOCK_1:${frame0}`),
      ...encoder.encode("...VIDEO_DATA_BLOCKS..."),
      ...encoder.encode(`SUBTITLE_BLOCK_2:${frame1}`),
      ...encoder.encode("...EBML_END_TAG"),
    ]);

    // Notice: NO trailer bytes whatsoever!
    const strippedBlob = new Blob([mockContainer.buffer]);
    const result = await extractMetadataAndCleanBlob(strippedBlob);

    expect(result.metadata["0"]?.filename).toBe("img0.jpg");
    expect(result.metadata["0"]?.width).toBe(1920);
    expect(result.metadata["0"]?.height).toBe(1080);
    expect(result.metadata["0"]?.has_alpha).toBe(false);

    expect(result.metadata["1"]?.filename).toBe("img1.png");
    expect(result.metadata["1"]?.width).toBe(2048);
    expect(result.metadata["1"]?.height).toBe(1536);
    expect(result.metadata["1"]?.has_alpha).toBe(true);
  });

  test("WebVTT timestamp formatting matches standard HH:MM:SS.mmm format", () => {
    expect(formatWebVTTTimestamp(0)).toBe("00:00:00.000");
    expect(formatWebVTTTimestamp(33)).toBe("00:00:00.033");
    expect(formatWebVTTTimestamp(1250)).toBe("00:00:01.250");
    expect(formatWebVTTTimestamp(65432)).toBe("00:01:05.432");
    expect(roundToMultipleOf2(1001)).toBe(1002);
    expect(roundToMultipleOf2(1000)).toBe(1000);
  });

  test("AbortSignal cancels encode pipeline cleanly with AbortError", async () => {
    const { executeEncodePipeline } = await import("./encoder-core");
    const abortCtrl = new AbortController();
    abortCtrl.abort();

    let errorThrown: any = null;
    try {
      await executeEncodePipeline(
        [{ file: new File(["mock"], "test.jpg"), name: "test.jpg" }],
        { fps: 30, quality: "balanced", codec: "av1" },
        () => {},
        abortCtrl.signal,
      );
    } catch (err: any) {
      errorThrown = err;
    }

    expect(errorThrown).not.toBeNull();
    expect(errorThrown.name).toBe("AbortError");
  });

  test("formatPercentDelta correctly calculates smaller and larger deltas", async () => {
    const { formatPercentDelta } = await import("./controller");
    expect(formatPercentDelta(750, 1000)).toBe("25% smaller");
    expect(formatPercentDelta(1250, 1000)).toBe("25% larger");
    expect(formatPercentDelta(980, 1000)).toBe("2.0% smaller");
    expect(formatPercentDelta(1050, 1000)).toBe("5.0% larger");
    expect(formatPercentDelta(1000, 1000)).toBe("same size");
    expect(formatPercentDelta(1000, 0)).toBe("");
  });

  test("In-container WebVTT metadata extraction restores orig_size", async () => {
    const frame = JSON.stringify({ filename: "img.jpg", width: 800, height: 600, has_alpha: false, orig_size: 45678 });
    const mockContainer = new Uint8Array([
      ...new TextEncoder().encode("EBML..."),
      ...new TextEncoder().encode(`CUE:${frame}`),
    ]);
    const strippedBlob = new Blob([mockContainer.buffer]);
    const result = await extractMetadataAndCleanBlob(strippedBlob);
    expect(result.metadata["0"]?.orig_size).toBe(45678);
  });

  test("isMobileOrTablet utility function returns boolean without crashing in Node/Bun", async () => {
    const { isMobileOrTablet, getDeviceHardwareProfile, probeHardwareResolutionSupport } = await import("./codecs");
    expect(typeof isMobileOrTablet()).toBe("boolean");

    const profile = getDeviceHardwareProfile();
    expect(profile.deviceMemoryGb).toBeGreaterThanOrEqual(1);
    expect(profile.maxCacheMemoryBytes).toBeGreaterThanOrEqual(30 * 1024 * 1024);
    expect(profile.maxBitrateLossless).toBeGreaterThan(0);

    const probe = await probeHardwareResolutionSupport("av1", 1920, 1080, 10_000_000, 30);
    expect(typeof probe.supported).toBe("boolean");
  });
});
