export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Rapidly reads image dimensions from file header bytes without decoding full image pixels.
 * Supports PNG, GIF, WebP, and JPEG. Falls back to createImageBitmap if header parsing fails.
 */
export async function fastGetImageDimensions(file: File): Promise<ImageDimensions> {
  try {
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";

    // 1. PNG Header (first 32 bytes)
    if (ext === "png" || file.type === "image/png") {
      const slice = await file.slice(0, 32).arrayBuffer();
      const view = new DataView(slice);
      if (view.byteLength >= 24 && view.getUint32(0) === 0x89504e47) {
        const width = view.getUint32(16, false);
        const height = view.getUint32(20, false);
        if (width > 0 && height > 0) return { width, height };
      }
    }

    // 2. GIF Header (first 16 bytes)
    if (ext === "gif" || file.type === "image/gif") {
      const slice = await file.slice(0, 16).arrayBuffer();
      const bytes = new Uint8Array(slice);
      if (bytes.length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
        const view = new DataView(slice);
        const width = view.getUint16(6, true);
        const height = view.getUint16(8, true);
        if (width > 0 && height > 0) return { width, height };
      }
    }

    // 3. WebP Header (first 32 bytes)
    if (ext === "webp" || file.type === "image/webp") {
      const slice = await file.slice(0, 32).arrayBuffer();
      const bytes = new Uint8Array(slice);
      if (
        bytes.length >= 16 &&
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && // RIFF
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 // WEBP
      ) {
        const chunkType = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
        if (chunkType === "VP8 " && bytes.length >= 30) {
          const width = (bytes[26]! | (bytes[27]! << 8)) & 0x3fff;
          const height = (bytes[28]! | (bytes[29]! << 8)) & 0x3fff;
          if (width > 0 && height > 0) return { width, height };
        } else if (chunkType === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
          const b0 = bytes[21]!;
          const b1 = bytes[22]!;
          const b2 = bytes[23]!;
          const b3 = bytes[24]!;
          const width = 1 + ((b0 | (b1 << 8)) & 0x3fff);
          const height = 1 + (((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)) & 0x3fff);
          if (width > 0 && height > 0) return { width, height };
        } else if (chunkType === "VP8X" && bytes.length >= 30) {
          const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
          const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
          if (width > 0 && height > 0) return { width, height };
        }
      }
    }

    // 4. JPEG Header (scan first 64KB for SOF markers)
    if (ext === "jpg" || ext === "jpeg" || file.type === "image/jpeg") {
      const slice = await file.slice(0, 65536).arrayBuffer();
      const bytes = new Uint8Array(slice);
      if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
        let offset = 2;
        while (offset < bytes.length) {
          if (bytes[offset] !== 0xff) {
            offset++;
            continue;
          }
          while (bytes[offset] === 0xff && offset < bytes.length) {
            offset++;
          }
          if (offset >= bytes.length) break;
          const marker = bytes[offset++];
          if (marker === 0xd9 || marker === 0xda) break; // EOI or SOS
          if (offset + 2 > bytes.length) break;
          const len = (bytes[offset]! << 8) | bytes[offset + 1]!;
          const isSOF =
            (marker >= 0xc0 && marker <= 0xc3) ||
            (marker >= 0xc5 && marker <= 0xc7) ||
            (marker >= 0xc9 && marker <= 0xcb) ||
            (marker >= 0xcd && marker <= 0xcf);
          if (isSOF && offset + 7 <= bytes.length) {
            const height = (bytes[offset + 3]! << 8) | bytes[offset + 4]!;
            const width = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
            if (width > 0 && height > 0) return { width, height };
          }
          offset += len;
        }
      }
    }
  } catch {
    // Fall through to native createImageBitmap fallback
  }

  // Fallback to browser decoding without canvas allocation
  const bitmap = await createImageBitmap(file);
  const dims: ImageDimensions = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return dims;
}
