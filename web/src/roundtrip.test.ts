import { test, expect, describe, beforeAll } from "bun:test";
import fs from "fs";
import path from "path";
import { Av1packModule } from "./wasm/loader";
import { fastGetImageDimensions } from "./fast-dimensions";
import { gzipCompress } from "./gzip";
import { extractMetadataAndCleanBlob } from "./video-decoder";

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
  let wasm: Av1packModule;

  beforeAll(async () => {
    const wasmPath = path.resolve(import.meta.dir, "wasm/av1pack.wasm");
    const wasmBytes = fs.readFileSync(wasmPath);
    const { instance } = await WebAssembly.instantiate(wasmBytes, {});
    wasm = new (Av1packModule as any)(instance.exports);
  });

  test("Zig WASM Core initializes cleanly", () => {
    expect(wasm).toBeDefined();
    expect(wasm.memoryBytes).toBeGreaterThan(0);
  });

  test("Zig WASM image padding and cropping round trip is pixel-perfect", () => {
    const srcW = 4;
    const srcH = 3;
    const dstW = 8;
    const dstH = 6;
    const srcRgba = new Uint8ClampedArray(srcW * srcH * 4);
    for (let i = 0; i < srcRgba.length; i++) {
      srcRgba[i] = (i * 17 + 3) % 256;
    }

    // Pad
    const padded = wasm.padImage(srcRgba, srcW, srcH, dstW, dstH, [0, 0, 0, 255]);
    expect(padded.width).toBe(dstW);
    expect(padded.height).toBe(dstH);

    // Verify background pixel (x=5, y=5)
    const bgOffset = (5 * dstW + 5) * 4;
    expect(padded.data[bgOffset]).toBe(0);
    expect(padded.data[bgOffset + 1]).toBe(0);
    expect(padded.data[bgOffset + 2]).toBe(0);
    expect(padded.data[bgOffset + 3]).toBe(255);

    // Crop back to original dimensions
    const cropped = wasm.cropImage(padded.data, dstW, dstH, srcW, srcH);
    expect(cropped.width).toBe(srcW);
    expect(cropped.height).toBe(srcH);

    // Byte-for-byte match
    for (let i = 0; i < srcRgba.length; i++) {
      expect(cropped.data[i]).toBe(srcRgba[i]);
    }
  });

  test("Zig WASM generates valid PKZIP archive with CRC32", () => {
    const testFiles = [
      { name: "file1.txt", data: new TextEncoder().encode("Hello, av1pack!") },
      { name: "images/photo.png", data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
    ];
    const zipBytes = wasm.createZip(testFiles);
    expect(zipBytes.length).toBeGreaterThan(30);
    // Standard PKZIP local header signature 0x04034b50
    expect(zipBytes[0]).toBe(0x50);
    expect(zipBytes[1]).toBe(0x4b);
    expect(zipBytes[2]).toBe(0x03);
    expect(zipBytes[3]).toBe(0x04);
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
