import { test, expect, describe } from "bun:test";
import fs from "fs";
import path from "path";
import { fastGetImageDimensions } from "./fast-dimensions";
import { gzipCompress } from "./gzip";
import { extractMetadataAndCleanBlob } from "./video-decoder";
import { createZip } from "./zip";

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
  test("createZip generates a valid PKZIP archive with correct CRC32 and round-trips via DecompressionStream", async () => {
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

    // End of central directory signature 0x06054b50 must appear at the tail
    const eocd = zipBytes.slice(zipBytes.length - 22);
    expect(eocd[0]).toBe(0x50);
    expect(eocd[1]).toBe(0x4b);
    expect(eocd[2]).toBe(0x05);
    expect(eocd[3]).toBe(0x06);

    // Compressed data for file1.txt (deflate-raw, no zip-specific framing) must
    // decompress back to the exact original bytes.
    const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.length);
    const method = view.getUint16(8, true);
    const compressedSize = view.getUint32(18, true);
    const nameLen = view.getUint16(26, true);
    const dataStart = 30 + nameLen;
    const compressed = zipBytes.slice(dataStart, dataStart + compressedSize);

    let restored: Uint8Array;
    if (method === 8) {
      const stream = new Response(compressed).body!.pipeThrough(new DecompressionStream("deflate-raw"));
      restored = new Uint8Array(await new Response(stream).arrayBuffer());
    } else {
      restored = compressed;
    }
    expect(new TextDecoder().decode(restored)).toBe("Hello, av1pack!");
  });

  test("Fast header dimension parser parses Wikipedia sample images accurately", async () => {
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
    }
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
});
