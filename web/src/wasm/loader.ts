// Thin typed wrapper around av1pack-core WASM exports.
// Direct memory buffer manipulation without heavy serialization.

interface Av1packExports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  free(ptr: number, len: number): void;
  pad_image(
    src: number,
    src_w: number,
    src_h: number,
    dst: number,
    dst_w: number,
    dst_h: number,
    bg_r: number,
    bg_g: number,
    bg_b: number,
    bg_a: number,
  ): void;
  crop_image(
    src: number,
    src_w: number,
    src_h: number,
    dst: number,
    dst_w: number,
    dst_h: number,
  ): void;
  calculate_crc32(ptr: number, len: number): number;
  zip_reset(): void;
  zip_add_file(name_ptr: number, name_len: number, data_ptr: number, data_len: number): number;
  zip_build(): number;
  zip_get_ptr(): number;
}

export class Av1packModule {
  private constructor(private readonly exports: Av1packExports) {}

  static async load(wasmUrl: string): Promise<Av1packModule> {
    const resp = await fetch(wasmUrl);
    const bytes = await resp.arrayBuffer();
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return new Av1packModule(instance.exports as unknown as Av1packExports);
  }

  private get memory(): ArrayBuffer {
    return this.exports.memory.buffer;
  }

  /** Current size of WASM memory in bytes. */
  get memoryBytes(): number {
    return this.exports.memory.buffer.byteLength;
  }

  /** Pads an RGBA image onto the target bounding box (dstW, dstH). */
  padImage(
    srcRgba: Uint8ClampedArray | Uint8Array,
    srcW: number,
    srcH: number,
    dstW: number,
    dstH: number,
    bg: [number, number, number, number] = [0, 0, 0, 0],
  ): ImageData {
    const srcLen = srcW * srcH * 4;
    const dstLen = dstW * dstH * 4;

    const srcPtr = this.exports.alloc(srcLen);
    const dstPtr = this.exports.alloc(dstLen);
    if (srcPtr === 0 || dstPtr === 0) {
      if (srcPtr) this.exports.free(srcPtr, srcLen);
      if (dstPtr) this.exports.free(dstPtr, dstLen);
      throw new Error("Failed to allocate memory in WASM for padding");
    }

    try {
      new Uint8Array(this.memory, srcPtr, srcLen).set(srcRgba);
      this.exports.pad_image(
        srcPtr,
        srcW,
        srcH,
        dstPtr,
        dstW,
        dstH,
        bg[0],
        bg[1],
        bg[2],
        bg[3],
      );

      const dstData = new Uint8ClampedArray(dstLen);
      dstData.set(new Uint8ClampedArray(this.memory, dstPtr, dstLen));
      return new ImageData(dstData, dstW, dstH);
    } finally {
      this.exports.free(srcPtr, srcLen);
      this.exports.free(dstPtr, dstLen);
    }
  }

  /** Crops a padded frame back to its original dimensions (dstW, dstH). */
  cropImage(
    srcRgba: Uint8ClampedArray | Uint8Array,
    srcW: number,
    srcH: number,
    dstW: number,
    dstH: number,
  ): ImageData {
    const srcLen = srcW * srcH * 4;
    const dstLen = dstW * dstH * 4;

    const srcPtr = this.exports.alloc(srcLen);
    const dstPtr = this.exports.alloc(dstLen);
    if (srcPtr === 0 || dstPtr === 0) {
      if (srcPtr) this.exports.free(srcPtr, srcLen);
      if (dstPtr) this.exports.free(dstPtr, dstLen);
      throw new Error("Failed to allocate memory in WASM for cropping");
    }

    try {
      new Uint8Array(this.memory, srcPtr, srcLen).set(srcRgba);
      this.exports.crop_image(srcPtr, srcW, srcH, dstPtr, dstW, dstH);

      const dstData = new Uint8ClampedArray(dstLen);
      dstData.set(new Uint8ClampedArray(this.memory, dstPtr, dstLen));
      return new ImageData(dstData, dstW, dstH);
    } finally {
      this.exports.free(srcPtr, srcLen);
      this.exports.free(dstPtr, dstLen);
    }
  }

  /** Builds a standard PKZIP archive in memory using Zig's std.zip. */
  createZip(files: Array<{ name: string; data: Uint8Array }>): Uint8Array {
    this.exports.zip_reset();

    const allocations: Array<{ ptr: number; len: number }> = [];

    try {
      const encoder = new TextEncoder();
      for (const file of files) {
        const nameBytes = encoder.encode(file.name);
        const namePtr = this.exports.alloc(nameBytes.length);
        const dataPtr = this.exports.alloc(file.data.length);

        if (namePtr === 0 || (dataPtr === 0 && file.data.length > 0)) {
          throw new Error("WASM allocation failed while packing ZIP");
        }

        allocations.push({ ptr: namePtr, len: nameBytes.length });
        allocations.push({ ptr: dataPtr, len: file.data.length });

        new Uint8Array(this.memory, namePtr, nameBytes.length).set(nameBytes);
        new Uint8Array(this.memory, dataPtr, file.data.length).set(file.data);

        const ok = this.exports.zip_add_file(
          namePtr,
          nameBytes.length,
          dataPtr,
          file.data.length,
        );
        if (!ok) throw new Error(`Failed to add file ${file.name} to ZIP`);
      }

      const zipLen = this.exports.zip_build();
      if (zipLen === 0) throw new Error("WASM zip_build returned 0 bytes");

      const zipPtr = this.exports.zip_get_ptr();
      return new Uint8Array(this.memory, zipPtr, zipLen).slice();
    } finally {
      for (const alloc of allocations) {
        this.exports.free(alloc.ptr, alloc.len);
      }
      this.exports.zip_reset();
    }
  }

  /** Computes CRC-32 of a buffer in WASM. */
  calculateCrc32(data: Uint8Array): number {
    const ptr = this.exports.alloc(data.length);
    if (ptr === 0 && data.length > 0) throw new Error("Alloc failed");
    try {
      new Uint8Array(this.memory, ptr, data.length).set(data);
      return this.exports.calculate_crc32(ptr, data.length) >>> 0;
    } finally {
      this.exports.free(ptr, data.length);
    }
  }
}
