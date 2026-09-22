import { Muxer, ArrayBufferTarget } from "webm-muxer";
import type { ImageFileInput } from "./fs-access";
import { gzipCompress } from "./gzip";
import { fastGetImageDimensions } from "./fast-dimensions";
import { CODEC_DEFINITIONS, type CodecFamily } from "./codecs";

export interface AlbumMetadataItem {
  filename: string;
  width: number;
  height: number;
  has_alpha: boolean;
}

export type AlbumMetadata = Record<string, AlbumMetadataItem>;

export interface EncodeOptions {
  fps: number;
  quality: "lossless" | "high" | "balanced";
  codec?: CodecFamily;
}

export interface EncodeResult {
  cleanBlob: Blob;
  exportBlob: Blob;
  metadata: AlbumMetadata;
  bboxWidth: number;
  bboxHeight: number;
  durationSeconds: number;
}

export type ProgressCallback = (stage: string, current: number, total: number) => void;

function roundToMultipleOf2(value: number): number {
  return Math.round(value / 2) * 2;
}

function checkHasAlpha(data: Uint8ClampedArray): boolean {
  for (let i = 3; i < data.length; i += 4) {
    if (data[i]! < 255) return true;
  }
  return false;
}

async function selectSupportedCodec(
  family: CodecFamily,
  width: number,
  height: number,
  bitrate: number,
  framerate: number,
): Promise<{
  codecString: string;
  containerCodec: "V_AV1" | "V_VP9" | "V_VP8";
  hardwareAcceleration: HardwareAcceleration;
}> {
  const def = CODEC_DEFINITIONS[family] || CODEC_DEFINITIONS.av1;

  for (const hw of ["prefer-hardware", "no-preference"] as const) {
    for (const codec of def.candidates) {
      const config: VideoEncoderConfig = {
        codec,
        width,
        height,
        bitrate,
        framerate,
        bitrateMode: "variable",
        hardwareAcceleration: hw,
      };
      try {
        const support = await VideoEncoder.isConfigSupported(config);
        if (support.supported) {
          return {
            codecString: codec,
            containerCodec: def.containerCodec,
            hardwareAcceleration: hw,
          };
        }
      } catch {
        // Continue to next candidate
      }
    }
  }
  throw new Error(
    `Browser does not support ${def.name} video encoding at this resolution. Please verify WebCodecs ${def.name} support.`,
  );
}

/**
 * Runs the encoding pipeline completely inside a dedicated Web Worker,
 * keeping the browser's main thread free for buttery smooth UI interactions.
 */
export async function encodeAlbumInWorker(
  files: ImageFileInput[],
  options: EncodeOptions,
  onProgress: ProgressCallback,
): Promise<EncodeResult> {
  const worker = new Worker(new URL("./encoder.worker.ts", import.meta.url), {
    type: "module",
  });

  const requestId = Math.random().toString(36).slice(2);

  return new Promise<EncodeResult>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent) => {
      const { id, type, stage, current, total, result, error } = e.data;
      if (id !== requestId) return;

      if (type === "progress") {
        onProgress(stage, current, total);
      } else if (type === "success") {
        worker.terminate();
        resolve(result);
      } else if (type === "error") {
        worker.terminate();
        reject(new Error(error));
      }
    };

    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || "Unknown error occurred in encoder Web Worker"));
    };

    worker.onmessageerror = () => {
      worker.terminate();
      reject(new Error("Failed to deserialize message from encoder Web Worker"));
    };

    worker.postMessage({
      id: requestId,
      type: "encode",
      files,
      options,
    });
  });
}

/**
 * Fallback main thread encoding with fast dimension parsing and backpressure.
 */
export async function encodeAlbumOnMainThread(
  files: ImageFileInput[],
  options: EncodeOptions,
  onProgress: ProgressCallback,
): Promise<EncodeResult> {
  if (files.length === 0) throw new Error("No images provided to encode");

  // Step 1: Rapid dimension scanning without decoding full image pixels
  onProgress("Scanning dimensions & bounding box", 0, files.length);

  let maxWidth = 0;
  let maxHeight = 0;
  const dimensions = new Array<{ width: number; height: number }>(files.length);

  for (let i = 0; i < files.length; i++) {
    const dims = await fastGetImageDimensions(files[i]!.file);
    dimensions[i] = dims;
    if (dims.width > maxWidth) maxWidth = dims.width;
    if (dims.height > maxHeight) maxHeight = dims.height;

    if (i % 10 === 0 || i === files.length - 1) {
      onProgress("Scanning dimensions & bounding box", i + 1, files.length);
    }
  }

  const bboxWidth = roundToMultipleOf2(maxWidth);
  const bboxHeight = roundToMultipleOf2(maxHeight);

  // Step 2: Configure WebCodecs VideoEncoder for chosen codec
  const codecFamily: CodecFamily = options.codec || "av1";
  const codecDisplayName = CODEC_DEFINITIONS[codecFamily]?.name || "Video";
  onProgress(`Initializing ${codecDisplayName} video encoder`, 0, files.length);

  const totalPixels = bboxWidth * bboxHeight;
  let targetBitrate: number;
  const bitrateMultiplier = codecFamily === "av1" ? 1.0 : 1.2;

  if (options.quality === "lossless") {
    targetBitrate = Math.max(25_000_000, Math.round(totalPixels * options.fps * 0.45 * bitrateMultiplier));
  } else if (options.quality === "high") {
    targetBitrate = Math.max(15_000_000, Math.round(totalPixels * options.fps * 0.25 * bitrateMultiplier));
  } else {
    targetBitrate = Math.max(8_000_000, Math.round(totalPixels * options.fps * 0.15 * bitrateMultiplier));
  }

  const { codecString, containerCodec, hardwareAcceleration } = await selectSupportedCodec(
    codecFamily,
    bboxWidth,
    bboxHeight,
    targetBitrate,
    options.fps,
  );

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: {
      codec: containerCodec,
      width: bboxWidth,
      height: bboxHeight,
      frameRate: options.fps,
    },
    firstTimestampBehavior: "offset",
  });

  let encoderError: any = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      muxer.addVideoChunk(chunk, meta);
    },
    error: (e) => {
      console.error("VideoEncoder error:", e);
      encoderError = e;
    },
  });

  encoder.configure({
    codec: codecString,
    width: bboxWidth,
    height: bboxHeight,
    bitrate: targetBitrate,
    framerate: options.fps,
    bitrateMode: "variable",
    hardwareAcceleration,
  });

  // Step 3: Draw each image directly onto the padded canvas (GPU-accelerated,
  // no CPU readback) and feed it to the VideoEncoder. Padding is just placing
  // the source at (0,0) over a solid background, which drawImage/fillRect
  // already do without ever touching pixel data on the CPU.
  const tempCanvas = document.createElement("canvas");
  const tempCtx = tempCanvas.getContext("2d", { willReadFrequently: true })!;

  const paddedCanvas = document.createElement("canvas");
  paddedCanvas.width = bboxWidth;
  paddedCanvas.height = bboxHeight;
  const paddedCtx = paddedCanvas.getContext("2d")!;

  const frameDurationUs = Math.round(1_000_000 / options.fps);
  const metadata: AlbumMetadata = {};

  for (let i = 0; i < files.length; i++) {
    if (encoderError) throw new Error(`Video encoder error: ${encoderError?.message || encoderError}`);

    const item = files[i]!;
    const dims = dimensions[i]!;
    const width = dims.width;
    const height = dims.height;

    const bitmap = await createImageBitmap(item.file);

    const isJpeg = item.file.type === "image/jpeg" || /\.jpe?g$/i.test(item.name);
    let hasAlpha = false;
    if (!isJpeg) {
      // Only pay for a CPU readback when we actually need to inspect alpha.
      tempCanvas.width = width;
      tempCanvas.height = height;
      tempCtx.clearRect(0, 0, width, height);
      tempCtx.drawImage(bitmap, 0, 0);
      const srcImageData = tempCtx.getImageData(0, 0, width, height);
      hasAlpha = checkHasAlpha(srcImageData.data);
    }

    metadata[i.toString()] = {
      filename: item.name,
      width,
      height,
      has_alpha: hasAlpha,
    };

    paddedCtx.clearRect(0, 0, bboxWidth, bboxHeight);
    if (!hasAlpha) {
      paddedCtx.fillStyle = "#000000";
      paddedCtx.fillRect(0, 0, bboxWidth, bboxHeight);
    }
    paddedCtx.drawImage(bitmap, 0, 0);
    bitmap.close();

    const timestamp = i * frameDurationUs;
    const videoFrame = new VideoFrame(paddedCanvas, {
      timestamp,
      duration: frameDurationUs,
    });

    const keyFrame = i === 0 || i % 10 === 0;
    encoder.encode(videoFrame, { keyFrame });
    videoFrame.close();

    // Backpressure control: keep queue bounded
    // Backpressure control: keep queue bounded
    if (encoder.encodeQueueSize > 4) {
      await new Promise<void>((resolve, reject) => {
        if (encoderError) {
          reject(new Error(`VideoEncoder error: ${encoderError?.message || encoderError}`));
          return;
        }
        const timer = setTimeout(() => {
          encoder.ondequeue = null;
          resolve();
        }, 2000);

        encoder.ondequeue = () => {
          if (encoderError) {
            clearTimeout(timer);
            encoder.ondequeue = null;
            reject(new Error(`VideoEncoder error: ${encoderError?.message || encoderError}`));
            return;
          }
          if (encoder.encodeQueueSize <= 2) {
            clearTimeout(timer);
            encoder.ondequeue = null;
            resolve();
          }
        };
      });
    }

    if (i % 2 === 0 || i === files.length - 1) {
      onProgress(`Encoding ${codecDisplayName} frames`, i + 1, files.length);
    }
  }

  if (encoderError) throw new Error(`VideoEncoder error: ${encoderError?.message || encoderError}`);

  // Step 4: Flush encoder and finalize muxer
  onProgress(`Finalizing ${codecDisplayName} WebM video`, files.length, files.length);
  await encoder.flush();
  encoder.close();
  muxer.finalize();

  const videoBuffer = target.buffer;
  const cleanBlob = new Blob([videoBuffer], { type: "video/webm" });

  // Step 5: Package metadata trailer for export
  const metaJsonString = JSON.stringify(metadata);
  const metaJsonBytes = new TextEncoder().encode(metaJsonString);
  const compressedMeta = await gzipCompress(metaJsonBytes);

  const trailerMagic = new TextEncoder().encode("AV1PACK\0");
  const metaLenBuffer = new Uint8Array(4);
  new DataView(metaLenBuffer.buffer).setUint32(0, compressedMeta.length, true);

  const combined = new Uint8Array(
    videoBuffer.byteLength + compressedMeta.length + trailerMagic.length + 4,
  );
  combined.set(new Uint8Array(videoBuffer), 0);
  combined.set(compressedMeta, videoBuffer.byteLength);
  combined.set(trailerMagic, videoBuffer.byteLength + compressedMeta.length);
  combined.set(metaLenBuffer, videoBuffer.byteLength + compressedMeta.length + trailerMagic.length);

  const exportBlob = new Blob([combined.buffer], { type: "video/webm" });

  return {
    cleanBlob,
    exportBlob,
    metadata,
    bboxWidth,
    bboxHeight,
    durationSeconds: files.length / options.fps,
  };
}

/**
 * Encodes image files using the selected codec in a WebM container.
 * Delegates to a Web Worker to avoid blocking the main thread,
 * falling back to main-thread encoding if workers lack WebCodecs support.
 */
export async function encodeAlbum(
  files: ImageFileInput[],
  options: EncodeOptions,
  onProgress: ProgressCallback,
): Promise<EncodeResult> {
  try {
    return await encodeAlbumInWorker(files, options, onProgress);
  } catch (workerErr: any) {
    console.warn("Worker encoding failed, falling back to main thread:", workerErr);
    return await encodeAlbumOnMainThread(files, options, onProgress);
  }
}
