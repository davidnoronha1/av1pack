import type { Av1packModule } from "./wasm/loader";
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
  renderFrame: (index: number, canvas: HTMLCanvasElement, wasm: Av1packModule) => Promise<void>;
  extractAllFrames: (
    wasm: Av1packModule,
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
    video.onloadedmetadata = () => resolve();
    video.onerror = () => {
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

  const seekToTime = (timeSeconds: number): Promise<void> => {
    return new Promise((resolve) => {
      const onSeeked = () => {
        video.removeEventListener("seeked", onSeeked);
        resolve();
      };
      video.addEventListener("seeked", onSeeked);
      video.currentTime = Math.max(0, Math.min(timeSeconds, video.duration));
    });
  };

  const renderFrame = async (
    index: number,
    targetCanvas: HTMLCanvasElement,
    wasm: Av1packModule,
  ): Promise<void> => {
    const meta = metadata[index.toString()];
    if (!meta) return;

    // Seek to middle of frame time window for crisp capture
    const time = (index + 0.5) / fps;
    await seekToTime(time);

    scratchCtx.drawImage(video, 0, 0, bboxWidth, bboxHeight);
    const paddedImageData = scratchCtx.getImageData(0, 0, bboxWidth, bboxHeight);

    // Crop back to original dimensions using Zig WASM
    const croppedImageData = wasm.cropImage(
      paddedImageData.data,
      bboxWidth,
      bboxHeight,
      meta.width,
      meta.height,
    );

    targetCanvas.width = meta.width;
    targetCanvas.height = meta.height;
    const targetCtx = targetCanvas.getContext("2d")!;
    targetCtx.putImageData(croppedImageData, 0, 0);
  };

  const extractAllFrames = async (
    wasm: Av1packModule,
    onProgress: ProgressCallback,
  ): Promise<Array<{ name: string; data: Uint8Array }>> => {
    const results: Array<{ name: string; data: Uint8Array }> = [];
    const exportCanvas = document.createElement("canvas");

    for (let i = 0; i < totalFrames; i++) {
      const meta = metadata[i.toString()]!;
      onProgress("Extracting & unpadding frames", i + 1, totalFrames);

      await renderFrame(i, exportCanvas, wasm);

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
