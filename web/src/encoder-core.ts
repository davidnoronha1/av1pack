import { Muxer, ArrayBufferTarget, SubtitleEncoder } from "webm-muxer";
import { fastGetImageDimensions } from "./fast-dimensions";
import { CODEC_DEFINITIONS, isMobileOrTablet, type CodecFamily } from "./codecs";
import type { ImageFileInput } from "./fs-access";

export interface AlbumMetadataItem {
  filename: string;
  width: number;
  height: number;
  has_alpha: boolean;
  orig_size?: number;
  orig_width?: number;
  orig_height?: number;
}

export type AlbumMetadata = Record<string, AlbumMetadataItem>;

export type MaxResolution = "auto" | "4k" | "2k" | "1080p" | "original";

export interface EncodeOptions {
  fps: number;
  quality: "lossless" | "high" | "balanced";
  codec?: CodecFamily;
  maxResolution?: MaxResolution;
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

export function roundToMultipleOf2(value: number): number {
  return Math.round(value / 2) * 2;
}

export function formatWebVTTTimestamp(ms: number): string {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const millis = Math.floor(ms % 1000);
  return (
    hours.toString().padStart(2, "0") +
    ":" +
    minutes.toString().padStart(2, "0") +
    ":" +
    seconds.toString().padStart(2, "0") +
    "." +
    millis.toString().padStart(3, "0")
  );
}

export function createDrawingCanvas(
  width: number,
  height: number,
): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height);
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export async function selectSupportedCodec(
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
  if (typeof VideoEncoder === "undefined") {
    throw new Error("WebCodecs VideoEncoder is not available in this environment.");
  }

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
        // Continue searching candidates
      }
    }
  }

  throw new Error(
    `Browser does not support ${def.name} video encoding at ${width}x${height}. Please verify WebCodecs ${def.name} support.`,
  );
}

/**
 * Common, environment-agnostic encoding engine that runs identically
 * inside a Web Worker or on the main browser thread.
 */
export async function executeEncodePipeline(
  files: ImageFileInput[],
  options: EncodeOptions,
  onProgress: ProgressCallback,
  signal?: AbortSignal,
): Promise<EncodeResult> {
  if (files.length === 0) throw new Error("No images provided to encode");
  if (signal?.aborted) throw new DOMException("Encoding cancelled", "AbortError");

  // Step 1: Rapid dimension scan & alpha detection directly from file headers
  onProgress("Scanning image dimensions & headers", 0, files.length);

  let maxWidth = 0;
  let maxHeight = 0;
  const imageInfo = new Array<{ width: number; height: number; hasAlpha: boolean }>(files.length);

  for (let i = 0; i < files.length; i++) {
    if (signal?.aborted) throw new DOMException("Encoding cancelled", "AbortError");
    const dims = await fastGetImageDimensions(files[i]!.file);
    const hasAlpha = dims.hasAlpha ?? false;
    imageInfo[i] = { width: dims.width, height: dims.height, hasAlpha };
    if (dims.width > maxWidth) maxWidth = dims.width;
    if (dims.height > maxHeight) maxHeight = dims.height;

    if (i % 10 === 0 || i === files.length - 1) {
      onProgress("Scanning image dimensions & headers", i + 1, files.length);
    }
  }

  const isTabletOrMobile = isMobileOrTablet();
  const maxRes = options.maxResolution || "auto";

  let maxAllowedW = Infinity;
  let maxAllowedH = Infinity;

  if (maxRes === "1080p") {
    maxAllowedW = 1920;
    maxAllowedH = 1080;
  } else if (maxRes === "2k") {
    maxAllowedW = 2560;
    maxAllowedH = 1440;
  } else if (maxRes === "4k") {
    maxAllowedW = 3840;
    maxAllowedH = 2160;
  } else if (maxRes === "auto") {
    // Auto mode: safely caps at 4K (3840x2160) to prevent OOM crashes on mobile/tablets
    // while keeping full resolution for standard 1080p, 1440p, and 4K images.
    maxAllowedW = 3840;
    maxAllowedH = 2160;
  }
  // "original" keeps maxAllowedW and maxAllowedH as Infinity

  let scaleFactor = 1.0;
  if (maxWidth > maxAllowedW || maxHeight > maxAllowedH) {
    scaleFactor = Math.min(maxAllowedW / maxWidth, maxAllowedH / maxHeight);
  }

  const bboxWidth = Math.max(2, roundToMultipleOf2(Math.round(maxWidth * scaleFactor)));
  const bboxHeight = Math.max(2, roundToMultipleOf2(Math.round(maxHeight * scaleFactor)));

  // Step 2: Configure WebCodecs VideoEncoder for chosen codec
  const codecFamily: CodecFamily = options.codec || "av1";
  const codecDisplayName = CODEC_DEFINITIONS[codecFamily]?.name || "Video";
  onProgress(`Configuring ${codecDisplayName} video encoder`, 0, files.length);

  const totalPixels = bboxWidth * bboxHeight;
  let targetBitrate: number;
  const bitrateMultiplier = codecFamily === "av1" ? 1.0 : 1.2;

  const maxBitrateCap = isTabletOrMobile
    ? options.quality === "lossless"
      ? 35_000_000
      : options.quality === "high"
        ? 20_000_000
        : 12_000_000
    : options.quality === "lossless"
      ? 50_000_000
      : options.quality === "high"
        ? 30_000_000
        : 18_000_000;

  if (options.quality === "lossless") {
    targetBitrate = Math.min(
      maxBitrateCap,
      Math.max(
        15_000_000,
        Math.round(totalPixels * options.fps * 0.35 * bitrateMultiplier),
      ),
    );
  } else if (options.quality === "high") {
    targetBitrate = Math.min(
      maxBitrateCap,
      Math.max(
        10_000_000,
        Math.round(totalPixels * options.fps * 0.20 * bitrateMultiplier),
      ),
    );
  } else {
    targetBitrate = Math.min(
      maxBitrateCap,
      Math.max(
        6_000_000,
        Math.round(totalPixels * options.fps * 0.12 * bitrateMultiplier),
      ),
    );
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
    subtitles: {
      codec: "V_TEXT/WEBVTT",
    },
    firstTimestampBehavior: "offset",
  });

  const subtitleEncoder = new SubtitleEncoder({
    output: (chunk, meta) => {
      muxer.addSubtitleChunk(chunk, meta);
    },
    error: (err) => {
      console.error("SubtitleEncoder error:", err);
    },
  });
  subtitleEncoder.configure({ codec: "webvtt" });

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

  // Step 3: Stream frames to encoder with zero-copy fast-path
  let paddedCanvas: (OffscreenCanvas | HTMLCanvasElement) | null = null;
  let paddedCtx: (CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) | null = null;

  const frameDurationUs = Math.round(1_000_000 / options.fps);
  const frameDurationMs = Math.round(1_000 / options.fps);
  const metadata: AlbumMetadata = {};

  for (let i = 0; i < files.length; i++) {
    if (encoderError) throw new Error(`Video encoder error: ${encoderError?.message || encoderError}`);

    if (signal?.aborted) {
      if (encoder.state !== "closed") encoder.close();
      throw new DOMException("Encoding cancelled", "AbortError");
    }

    const item = files[i]!;
    const info = imageInfo[i]!;
    const rawWidth = info.width;
    const rawHeight = info.height;
    const hasAlpha = info.hasAlpha;

    const width = scaleFactor === 1.0 ? rawWidth : Math.max(2, roundToMultipleOf2(Math.round(rawWidth * scaleFactor)));
    const height = scaleFactor === 1.0 ? rawHeight : Math.max(2, roundToMultipleOf2(Math.round(rawHeight * scaleFactor)));

    const origSize = item.file?.size;

    metadata[i.toString()] = {
      filename: item.name,
      width,
      height,
      has_alpha: hasAlpha,
      orig_size: origSize,
      orig_width: scaleFactor === 1.0 ? undefined : rawWidth,
      orig_height: scaleFactor === 1.0 ? undefined : rawHeight,
    };

    // Emit in-container WebVTT timed metadata cue for this frame
    const startMs = Math.round((i / options.fps) * 1000);
    const endMs = startMs + frameDurationMs;
    const cuePayload = JSON.stringify({
      filename: item.name,
      width,
      height,
      has_alpha: hasAlpha,
      orig_size: origSize,
      orig_width: scaleFactor === 1.0 ? undefined : rawWidth,
      orig_height: scaleFactor === 1.0 ? undefined : rawHeight,
    });
    const cueBlock = `${formatWebVTTTimestamp(startMs)} --> ${formatWebVTTTimestamp(endMs)}\n${cuePayload}\n\n`;
    if (i === 0) {
      subtitleEncoder.encode(`WEBVTT\n\n${cueBlock}`);
    } else {
      subtitleEncoder.encode(cueBlock);
    }

    const timestamp = i * frameDurationUs;
    const bitmap = await createImageBitmap(item.file);
    let videoFrame: VideoFrame;

    if (scaleFactor === 1.0 && width === bboxWidth && height === bboxHeight && !hasAlpha) {
      // Zero-copy direct fast-path: image already matches bounding box.
      // Pass the GPU texture directly into VideoFrame without intermediate canvas blitting.
      videoFrame = new VideoFrame(bitmap, {
        timestamp,
        duration: frameDurationUs,
      });
      bitmap.close();
    } else {
      // Padding / scaling path: allocate canvas on-demand and pad
      if (!paddedCanvas) {
        paddedCanvas = createDrawingCanvas(bboxWidth, bboxHeight);
        paddedCtx = paddedCanvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
      }

      if (hasAlpha) {
        paddedCtx.clearRect(0, 0, bboxWidth, bboxHeight);
      } else {
        paddedCtx.fillStyle = "#000000";
        paddedCtx.fillRect(0, 0, bboxWidth, bboxHeight);
      }
      paddedCtx.drawImage(bitmap, 0, 0, width, height);
      bitmap.close();

      videoFrame = new VideoFrame(paddedCanvas as CanvasImageSource, {
        timestamp,
        duration: frameDurationUs,
      });
    }

    const keyFrame = i === 0 || i % 10 === 0;
    encoder.encode(videoFrame, { keyFrame });
    videoFrame.close();

    // Backpressure control: keep queue tightly bounded (max 1-2 frames in flight to prevent OOM)
    if (encoder.encodeQueueSize >= 2) {
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException("Encoding cancelled", "AbortError"));
          return;
        }
        if (encoderError) {
          reject(new Error(`VideoEncoder error: ${encoderError?.message || encoderError}`));
          return;
        }
        const onAbort = () => {
          clearTimeout(timer);
          encoder.ondequeue = null;
          reject(new DOMException("Encoding cancelled", "AbortError"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });

        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          encoder.ondequeue = null;
          resolve();
        }, 2000);

        encoder.ondequeue = () => {
          if (signal?.aborted) {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            encoder.ondequeue = null;
            reject(new DOMException("Encoding cancelled", "AbortError"));
            return;
          }
          if (encoderError) {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            encoder.ondequeue = null;
            reject(new Error(`VideoEncoder error: ${encoderError?.message || encoderError}`));
            return;
          }
          if (encoder.encodeQueueSize <= 1) {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
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

  // Free canvas memory immediately
  paddedCanvas = null;
  paddedCtx = null;

  if (signal?.aborted) {
    if (encoder.state !== "closed") encoder.close();
    throw new DOMException("Encoding cancelled", "AbortError");
  }

  if (encoderError) throw new Error(`VideoEncoder error: ${encoderError?.message || encoderError}`);

  // Step 4: Flush encoder and finalize muxer
  onProgress(`Finalizing ${codecDisplayName} WebM video`, files.length, files.length);
  await encoder.flush();
  encoder.close();
  muxer.finalize();

  const videoBuffer = target.buffer;
  const webmBlob = new Blob([videoBuffer], { type: "video/webm" });

  return {
    cleanBlob: webmBlob,
    exportBlob: webmBlob,
    metadata,
    bboxWidth,
    bboxHeight,
    durationSeconds: files.length / options.fps,
  };
}
