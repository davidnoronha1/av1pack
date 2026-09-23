export interface ImageDimensions {
  width: number;
  height: number;
  hasAlpha?: boolean;
}

/**
 * Rapidly reads image dimensions and alpha channel presence directly from file header bytes
 * without decoding full image pixels. Supports PNG, WebP, GIF, and JPEG.
 * Falls back to createImageBitmap if header parsing fails.
 */
export async function fastGetImageDimensions(file: File): Promise<ImageDimensions> {
  try {
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";

    // 1. PNG Header & Chunks (inspect up to 1024 bytes)
    if (ext === "png" || file.type === "image/png") {
      const slice = await file.slice(0, 1024).arrayBuffer();
      const view = new DataView(slice);
      const bytes = new Uint8Array(slice);

      if (view.byteLength >= 26 && view.getUint32(0) === 0x89504e47) {
        const width = view.getUint32(16, false);
        const height = view.getUint32(20, false);
        const colorType = bytes[25]!;

        let hasAlpha = false;
        if (colorType === 4 || colorType === 6) {
          // Grayscale with alpha (4) or RGBA (6)
          hasAlpha = true;
        } else {
          // Check for tRNS transparency chunk
          for (let i = 8; i < bytes.length - 8; i++) {
            if (
              bytes[i] === 0x74 && // 't'
              bytes[i + 1] === 0x52 && // 'R'
              bytes[i + 2] === 0x4e && // 'N'
              bytes[i + 3] === 0x53 // 'S'
            ) {
              hasAlpha = true;
              break;
            }
            if (
              bytes[i] === 0x49 && // 'I'
              bytes[i + 1] === 0x44 && // 'D'
              bytes[i + 2] === 0x41 && // 'A'
              bytes[i + 3] === 0x54 // 'T'
            ) {
              // Reached IDAT without seeing tRNS
              break;
            }
          }
        }

        if (width > 0 && height > 0) return { width, height, hasAlpha };
      }
    }

    // 2. GIF Header (first 1024 bytes)
    if (ext === "gif" || file.type === "image/gif") {
      const slice = await file.slice(0, 1024).arrayBuffer();
      const bytes = new Uint8Array(slice);
      if (bytes.length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
        const view = new DataView(slice);
        const width = view.getUint16(6, true);
        const height = view.getUint16(8, true);

        let hasAlpha = false;
        // Search for Graphic Control Extension (0x21 0xF9 0x04)
        for (let i = 10; i < bytes.length - 6; i++) {
          if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9 && bytes[i + 2] === 0x04) {
            const packedFlags = bytes[i + 3]!;
            if ((packedFlags & 0x01) !== 0) {
              hasAlpha = true;
            }
            break;
          }
        }

        if (width > 0 && height > 0) return { width, height, hasAlpha };
      }
    }

    // 3. WebP Header (first 64 bytes)
    if (ext === "webp" || file.type === "image/webp") {
      const slice = await file.slice(0, 64).arrayBuffer();
      const bytes = new Uint8Array(slice);
      if (
        bytes.length >= 16 &&
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && // RIFF
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 // WEBP
      ) {
        const chunkType = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
        if (chunkType === "VP8 " && bytes.length >= 30) {
          // Standard lossy VP8 never has an alpha channel
          const width = (bytes[26]! | (bytes[27]! << 8)) & 0x3fff;
          const height = (bytes[28]! | (bytes[29]! << 8)) & 0x3fff;
          if (width > 0 && height > 0) return { width, height, hasAlpha: false };
        } else if (chunkType === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
          // Lossless WebP
          const b0 = bytes[21]!;
          const b1 = bytes[22]!;
          const b2 = bytes[23]!;
          const b3 = bytes[24]!;
          const width = 1 + ((b0 | (b1 << 8)) & 0x3fff);
          const height = 1 + (((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)) & 0x3fff);
          const hasAlpha = (b3 & 0x10) !== 0;
          if (width > 0 && height > 0) return { width, height, hasAlpha };
        } else if (chunkType === "VP8X" && bytes.length >= 30) {
          // Extended WebP: bit 4 of flags (byte 20) indicates alpha
          const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
          const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
          const hasAlpha = (bytes[20]! & 0x10) !== 0;
          if (width > 0 && height > 0) return { width, height, hasAlpha };
        }
      }
    }

    // 4. JPEG Header (scan first 64KB for SOF markers; JPEGs never have alpha)
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
            if (width > 0 && height > 0) return { width, height, hasAlpha: false };
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
  const dims: ImageDimensions = { width: bitmap.width, height: bitmap.height, hasAlpha: false };
  bitmap.close();
  return dims;
}
