import type { AlbumMetadata, ProgressCallback } from "./video-encoder";
import { gzipDecompress } from "./gzip";

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

/** Extracts gzipped JSON metadata and returns a clean video blob without trailing non-container bytes. */
export async function extractMetadataAndCleanBlob(
  videoBlob: Blob,
  passedMetadata?: AlbumMetadata,
): Promise<ExtractedPayload> {
  const arrayBuffer = await videoBlob.arrayBuffer();
  const buffer = new Uint8Array(arrayBuffer);

  // Method 1: Check for AV1PACK trailer at end of file
  if (buffer.length >= 12) {
    const magicLen = 8; // "AV1PACK\0"
    const tailOffset = buffer.length - 4 - magicLen;
    const magic = new TextDecoder().decode(buffer.slice(tailOffset, tailOffset + magicLen));

    if (magic === "AV1PACK\0") {
      const metaLen = new DataView(buffer.buffer, buffer.byteOffset + buffer.length - 4, 4).getUint32(0, true);
      const metaStart = tailOffset - metaLen;
      if (metaStart >= 0) {
        const compressedMeta = buffer.slice(metaStart, metaStart + metaLen);
        const decompressed = await gzipDecompress(compressedMeta);
        const jsonStr = new TextDecoder().decode(decompressed);
        const metadata = JSON.parse(jsonStr) as AlbumMetadata;

        // Slice off the trailer so the browser media engine receives pure, valid WebM container bytes
        const cleanBlob = videoBlob.slice(0, metaStart, "video/webm");
        return { cleanBlob, metadata };
      }
    }
  }

  // Method 2: If metadata was already provided (e.g. directly after encoding)
  if (passedMetadata) {
    return { cleanBlob: videoBlob, metadata: passedMetadata };
  }

  // Method 3: Search for gzip magic header (0x1F, 0x8B, 0x08)
  for (let i = 0; i < buffer.length - 10; i++) {
    if (buffer[i] === 0x1f && buffer[i + 1] === 0x8b && buffer[i + 2] === 0x08) {
      try {
        const candidate = buffer.slice(i);
        const decompressed = await gzipDecompress(candidate);
        const jsonStr = new TextDecoder().decode(decompressed);
        const parsed = JSON.parse(jsonStr);
        if (typeof parsed === "object" && parsed !== null && ("0" in parsed || Object.keys(parsed).length > 0)) {
          return { cleanBlob: videoBlob, metadata: parsed as AlbumMetadata };
        }
      } catch {
        // Continue searching
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
  video.preload = "auto";

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timeout (10s) loading video into browser media engine. The video format or codec might not be supported."));
    }, 10000);

    video.onloadedmetadata = () => {
      clearTimeout(timer);
      resolve();
    };
    video.onerror = () => {
      clearTimeout(timer);
      const err = video.error;
      reject(new Error(`Failed to load video file into browser media engine (code: ${err?.code}, message: ${err?.message || "unknown"})`));
    };
  });

  const bboxWidth = video.videoWidth;
  const bboxHeight = video.videoHeight;

  // Intermediate offscreen canvas to capture unpadded video frames
  const scratchCanvas = document.createElement("canvas");
  scratchCanvas.width = bboxWidth;
  scratchCanvas.height = bboxHeight;
  const scratchCtx = scratchCanvas.getContext("2d", { willReadFrequently: true })!;

  // Frame cache (LRU up to 30 frames) for instant, stutter-free scrubbing of visited frames
  const frameCache = new Map<number, ImageData>();
  const MAX_CACHE_SIZE = 30;

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

    // Fast-path: Check cache first for instant 60 FPS scrub!
    const cached = frameCache.get(index);
    if (cached) {
      targetCanvas.width = meta.width;
      targetCanvas.height = meta.height;
      const targetCtx = targetCanvas.getContext("2d")!;
      targetCtx.putImageData(cached, 0, 0);
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

        let imgData = frameCache.get(idx);
        if (!imgData) {
          const time = (idx + 0.5) / fps;
          await seekToTime(time);

          scratchCtx.drawImage(video, 0, 0, bboxWidth, bboxHeight);
          // Cropping is just reading back the top-left sub-rectangle of the
          // padded frame: getImageData already takes a crop rect, so no
          // separate crop step (or extra copy) is needed.
          imgData = scratchCtx.getImageData(0, 0, curMeta.width, curMeta.height);

          if (frameCache.size >= MAX_CACHE_SIZE) {
            const oldestKey = frameCache.keys().next().value;
            if (oldestKey !== undefined) frameCache.delete(oldestKey);
          }
          frameCache.set(idx, imgData);
        }

        // Draw to target canvas if no newer frame was queued during seek/crop
        if (queuedFrameIndex === null || queuedFrameIndex === idx) {
          canvas.width = curMeta.width;
          canvas.height = curMeta.height;
          const targetCtx = canvas.getContext("2d")!;
          targetCtx.putImageData(imgData, 0, 0);
        }
      }
    } finally {
      isRendering = false;
    }
  };

  const extractAllFrames = async (
    onProgress: ProgressCallback,
  ): Promise<Array<{ name: string; data: Uint8Array }>> => {
    const results: Array<{ name: string; data: Uint8Array }> = [];
    const exportCanvas = document.createElement("canvas");

    for (let i = 0; i < totalFrames; i++) {
      const meta = metadata[i.toString()]!;
      onProgress("Extracting & unpadding frames", i + 1, totalFrames);

      await renderFrame(i, exportCanvas);

      const blob = await new Promise<Blob>((resolve) => {
        exportCanvas.toBlob((b) => resolve(b!), "image/png");
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
