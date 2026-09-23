import type { AlbumMetadata, ProgressCallback } from "./encoder-core";
import { gzipDecompress } from "./gzip";
import { isMobileOrTablet } from "./codecs";

export type { AlbumMetadata, ProgressCallback };

export interface DecodedAlbum {
  cleanBlob: Blob;
  metadata: AlbumMetadata;
  totalFrames: number;
  fps: number;
  duration: number;
  bboxWidth: number;
  bboxHeight: number;
  fileSize?: number;
  renderFrame: (index: number, canvas: HTMLCanvasElement) => Promise<void>;
  extractAllFrames: (
    onProgress: ProgressCallback,
  ) => Promise<Array<{ name: string; data: Uint8Array }>>;
  cleanup: () => void;
}

export interface ExtractedPayload {
  cleanBlob: Blob;
  metadata: AlbumMetadata;
}

/**
 * Searches the raw container bytes for embedded WebVTT JSON metadata cues.
 * Recovers album metadata even if the trailer was stripped by FFmpeg remuxing or video platforms.
 */
export function extractMetadataFromContainerBytes(buffer: Uint8Array): AlbumMetadata | null {
  const needle = new TextEncoder().encode('{"filename"');
  const indices: number[] = [];

  for (let i = 0; i <= buffer.length - needle.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (buffer[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      indices.push(i);
      i += needle.length;
    }
  }

  if (indices.length === 0) return null;

  const metadata: AlbumMetadata = {};
  const decoder = new TextDecoder();

  for (let k = 0; k < indices.length; k++) {
    const start = indices[k]!;
    let end = start;
    while (end < buffer.length && buffer[end] !== 0x7d /* '}' */) {
      end++;
    }
    if (end < buffer.length) {
      try {
        const jsonStr = decoder.decode(buffer.slice(start, end + 1));
        const parsed = JSON.parse(jsonStr);
        if (parsed && typeof parsed.filename === "string" && typeof parsed.width === "number") {
          metadata[k.toString()] = {
            filename: parsed.filename,
            width: parsed.width,
            height: parsed.height,
            has_alpha: Boolean(parsed.has_alpha),
            orig_size: typeof parsed.orig_size === "number" ? parsed.orig_size : undefined,
          };
        }
      } catch {
        // Skip malformed chunk
      }
    }
  }

  if (Object.keys(metadata).length > 0) {
    return metadata;
  }
  return null;
}

/**
 * Extracts album metadata from either:
 * 1. The trailer footer (instant read for native files).
 * 2. The in-container WebVTT metadata track (for files where trailer was stripped by FFmpeg or sharing platforms).
 * 3. Gzip trailer magic (legacy fallback).
 */
export async function extractMetadataAndCleanBlob(
  videoBlob: Blob,
  passedMetadata?: AlbumMetadata,
): Promise<ExtractedPayload> {
  // Method 1: If metadata was passed directly in memory (e.g. right after encode)
  if (passedMetadata) {
    return { cleanBlob: videoBlob, metadata: passedMetadata };
  }

  const arrayBuffer = await videoBlob.arrayBuffer();
  const buffer = new Uint8Array(arrayBuffer);

  // Method 2: Primary - In-container WebVTT metadata track
  const containerMetadata = extractMetadataFromContainerBytes(buffer);
  if (containerMetadata) {
    return { cleanBlob: videoBlob, metadata: containerMetadata };
  }

  // Method 3: Legacy fallback - check for older AV1PACK trailer
  if (buffer.length >= 12) {
    const magicLen = 8; // "AV1PACK\0"
    const tailOffset = buffer.length - 4 - magicLen;
    const isMagic =
      buffer[tailOffset] === 0x41 && // 'A'
      buffer[tailOffset + 1] === 0x56 && // 'V'
      buffer[tailOffset + 2] === 0x31 && // '1'
      buffer[tailOffset + 3] === 0x50 && // 'P'
      buffer[tailOffset + 4] === 0x41 && // 'A'
      buffer[tailOffset + 5] === 0x43 && // 'C'
      buffer[tailOffset + 6] === 0x4b && // 'K'
      buffer[tailOffset + 7] === 0x00; // '\0'

    if (isMagic) {
      const metaLen = new DataView(
        buffer.buffer,
        buffer.byteOffset + buffer.length - 4,
        4,
      ).getUint32(0, true);
      const metaStart = tailOffset - metaLen;
      if (metaStart >= 0) {
        const compressedMeta = buffer.subarray(metaStart, metaStart + metaLen);
        const decompressed = await gzipDecompress(compressedMeta);
        const jsonStr = new TextDecoder().decode(decompressed);
        const metadata = JSON.parse(jsonStr) as AlbumMetadata;

        const cleanBlob = videoBlob.slice(0, metaStart, "video/webm");
        return { cleanBlob, metadata };
      }
    }
  }

  throw new Error("Could not find av1pack album metadata in this video file.");
}

/** Opens a packed video and prepares the interactive frame reader. */
export async function loadPackedVideo(
  videoBlob: Blob,
  knownMetadata?: AlbumMetadata,
): Promise<DecodedAlbum> {
  const { cleanBlob, metadata } = await extractMetadataAndCleanBlob(videoBlob, knownMetadata);

  const frameIndices = Object.keys(metadata)
    .map(Number)
    .sort((a, b) => a - b);
  const totalFrames = frameIndices.length;
  const fps = 30;

  const videoUrl = URL.createObjectURL(cleanBlob);
  const video = document.createElement("video");
  video.src = videoUrl;
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          "Timeout (10s) loading video into browser media engine. The video format or codec might not be supported.",
        ),
      );
    }, 10000);

    video.onloadedmetadata = () => {
      clearTimeout(timer);
      resolve();
    };
    video.onerror = () => {
      clearTimeout(timer);
      const err = video.error;
      reject(
        new Error(
          `Failed to load video file into browser media engine (code: ${err?.code}, message: ${err?.message || "unknown"})`,
        ),
      );
    };
  });

  const bboxWidth = video.videoWidth;
  const bboxHeight = video.videoHeight;

  // Frame cache with strict memory budgeting (~40MB on mobile/tablet, ~80MB on desktop)
  const frameCache = new Map<number, ImageBitmap>();
  const isConstrained = isMobileOrTablet();
  const bytesPerFrame = Math.max(1, bboxWidth * bboxHeight * 4);
  const maxMemoryBudget = isConstrained ? 40 * 1024 * 1024 : 80 * 1024 * 1024;
  const maxCacheFrames = Math.max(
    2,
    Math.min(isConstrained ? 5 : 15, Math.floor(maxMemoryBudget / bytesPerFrame)),
  );

  let isRendering = false;
  let queuedFrameIndex: number | null = null;
  let currentCanvas: HTMLCanvasElement | null = null;

  const seekToTime = (timeSeconds: number): Promise<void> => {
    return new Promise((resolve) => {
      const totalDuration = totalFrames / fps;
      const maxTime =
        !isNaN(video.duration) && isFinite(video.duration) && video.duration > 0
          ? video.duration
          : totalDuration;
      const targetTime = Math.max(0, Math.min(timeSeconds, Math.max(0, maxTime - 0.001)));

      if (Math.abs(video.currentTime - targetTime) < 0.01) {
        resolve();
        return;
      }

      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          video.removeEventListener("seeked", onSeeked);
          resolve();
        }
      }, 400);

      const onSeeked = () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          video.removeEventListener("seeked", onSeeked);
          resolve();
        }
      };

      video.addEventListener("seeked", onSeeked, { once: true });
      video.currentTime = targetTime;
    });
  };

  const renderFrame = async (
    index: number,
    targetCanvas: HTMLCanvasElement,
  ): Promise<void> => {
    const meta = metadata[index.toString()];
    if (!meta) return;

    // Fast-path: Check cache first for instant GPU-blit scrubbing!
    const cached = frameCache.get(index);
    if (cached) {
      if (targetCanvas.width !== meta.width) targetCanvas.width = meta.width;
      if (targetCanvas.height !== meta.height) targetCanvas.height = meta.height;
      const targetCtx = targetCanvas.getContext("2d")!;
      targetCtx.drawImage(cached, 0, 0);
      return;
    }

    queuedFrameIndex = index;
    currentCanvas = targetCanvas;

    if (isRendering) return;

    isRendering = true;
    try {
      while (queuedFrameIndex !== null) {
        const idx = queuedFrameIndex;
        queuedFrameIndex = null;
        const curMeta = metadata[idx.toString()];
        const canvas = currentCanvas;
        if (!curMeta || !canvas) continue;

        let bitmap = frameCache.get(idx);
        if (!bitmap) {
          const time = (idx + 0.5) / fps;
          await seekToTime(time);

          // Zero-copy GPU crop: createImageBitmap extracts the native sub-rectangle
          // directly from the video texture without CPU readback (no getImageData).
          bitmap = await createImageBitmap(video, 0, 0, curMeta.width, curMeta.height);

          if (frameCache.size >= maxCacheFrames) {
            const oldestKey = frameCache.keys().next().value;
            if (oldestKey !== undefined) {
              const old = frameCache.get(oldestKey);
              old?.close();
              frameCache.delete(oldestKey);
            }
          }
          frameCache.set(idx, bitmap);
        }

        // Draw to target canvas if no newer frame was queued during seek
        if (queuedFrameIndex === null || queuedFrameIndex === idx) {
          if (canvas.width !== curMeta.width) canvas.width = curMeta.width;
          if (canvas.height !== curMeta.height) canvas.height = curMeta.height;
          const targetCtx = canvas.getContext("2d")!;
          targetCtx.drawImage(bitmap, 0, 0);
        }
      }
    } finally {
      isRendering = false;
    }
  };

  const extractAllFrames = async (
    onProgress: ProgressCallback,
  ): Promise<Array<{ name: string; data: Uint8Array }>> => {
    // Clear cache to free memory before bulk extraction
    for (const bmp of frameCache.values()) {
      bmp.close();
    }
    frameCache.clear();

    const results: Array<{ name: string; data: Uint8Array }> = [];
    const exportCanvas = document.createElement("canvas");

    for (let i = 0; i < totalFrames; i++) {
      const meta = metadata[i.toString()]!;
      onProgress("Extracting & unpadding frames", i + 1, totalFrames);

      await renderFrame(i, exportCanvas);

      // Clean up newly created frame bitmap immediately during extraction to prevent memory hoarding
      const cachedBmp = frameCache.get(i);
      if (cachedBmp) {
        cachedBmp.close();
        frameCache.delete(i);
      }

      // Preserve PNG for images with alpha or originally PNG; use high-quality JPEG for others to save 90% RAM
      const usePng = meta.has_alpha || meta.filename.toLowerCase().endsWith(".png");
      const mimeType = usePng ? "image/png" : "image/jpeg";
      const quality = usePng ? undefined : 0.95;

      const blob = await new Promise<Blob>((resolve) => {
        exportCanvas.toBlob((b) => resolve(b!), mimeType, quality);
      });

      const buffer = await blob.arrayBuffer();
      results.push({
        name: meta.filename,
        data: new Uint8Array(buffer),
      });
    }

    return results;
  };

  const cleanup = () => {
    for (const bmp of frameCache.values()) {
      bmp.close();
    }
    frameCache.clear();
    queuedFrameIndex = null;
    currentCanvas = null;
    video.src = "";
    URL.revokeObjectURL(videoUrl);
  };

  return {
    cleanBlob,
    metadata,
    totalFrames,
    fps,
    duration: video.duration || totalFrames / fps,
    bboxWidth,
    bboxHeight,
    fileSize: videoBlob.size,
    renderFrame,
    extractAllFrames,
    cleanup,
  };
}
