import { Muxer, ArrayBufferTarget, SubtitleEncoder } from "webm-muxer";
import { fastGetImageDimensions } from "./fast-dimensions";
import {
  CODEC_DEFINITIONS,
  isMobileOrTablet,
  getDeviceHardwareProfile,
  probeHardwareResolutionSupport,
  type CodecFamily,
} from "./codecs";
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

export interface DownscaleReport {
  originalWidth: number;
  originalHeight: number;
  scaledWidth: number;
  scaledHeight: number;
  scaleFactor: number;
  reason: string;
}

export interface EncodeResult {
  cleanBlob: Blob;
  exportBlob: Blob;
  metadata: AlbumMetadata;
  bboxWidth: number;
  bboxHeight: number;
  durationSeconds: number;
  downscaleReport?: DownscaleReport;
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

  const profile = getDeviceHardwareProfile();
  const maxRes = options.maxResolution || "auto";

  let scaleFactor = 1.0;
  let downscaleReason: string | undefined;

  if (maxRes === "1080p") {
    if (maxWidth > 1920 || maxHeight > 1080) {
      scaleFactor = Math.min(1920 / maxWidth, 1080 / maxHeight);
      downscaleReason = "1080p preset selected";
    }
  } else if (maxRes === "2k") {
    if (maxWidth > 2560 || maxHeight > 1440) {
      scaleFactor = Math.min(2560 / maxWidth, 1440 / maxHeight);
      downscaleReason = "2K preset selected";
    }
  } else if (maxRes === "4k") {
    if (maxWidth > 3840 || maxHeight > 2160) {
      scaleFactor = Math.min(3840 / maxWidth, 2160 / maxHeight);
      downscaleReason = "4K preset selected";
    }
  } else if (maxRes === "original") {
    scaleFactor = 1.0;
  } else {
    // "auto": Hardware-adaptive resolution selection
    // Prefer higher resolution if hardware GPU encoder and device memory can handle it!
    const roundedRawW = roundToMultipleOf2(maxWidth);
    const roundedRawH = roundToMultipleOf2(maxHeight);
    const rawPixels = roundedRawW * roundedRawH;

    // Check if device hardware and memory can safely handle the raw resolution natively
    // Raw resolutions above 4K (e.g. 6K, 8K, or 12MP-48MP camera photos) require 8GB+ RAM on desktop
    const canAttemptRaw =
      rawPixels <= 3840 * 2160 || (profile.deviceMemoryGb >= 8 && !profile.isMobile);

    let rawHwSupported = false;
    if (canAttemptRaw) {
      const probe = await probeHardwareResolutionSupport(
        options.codec || "av1",
        roundedRawW,
        roundedRawH,
        profile.maxBitrateLossless,
        options.fps,
      );
      rawHwSupported = probe.supported && probe.hardware;
    }

    if (rawHwSupported && canAttemptRaw) {
      // GPU hardware supports raw resolution directly! Keep native 1:1!
      scaleFactor = 1.0;
    } else {
      // Raw resolution exceeds GPU encoder envelope or device memory headroom.
      // Proactively test 4K (3840x2160):
      if (maxWidth > 3840 || maxHeight > 2160) {
        const factor4k = Math.min(3840 / maxWidth, 2160 / maxHeight);
        const w4k = Math.max(2, roundToMultipleOf2(Math.round(maxWidth * factor4k)));
        const h4k = Math.max(2, roundToMultipleOf2(Math.round(maxHeight * factor4k)));
        const probe4k = await probeHardwareResolutionSupport(
          options.codec || "av1",
          w4k,
          h4k,
          profile.maxBitrateLossless,
          options.fps,
        );

        if (probe4k.supported && (probe4k.hardware || !profile.isMobile)) {
          scaleFactor = factor4k;
          downscaleReason = `Hardware GPU encoder limit (${w4k}×${h4k} 4K)`;
        } else {
          // If 4K is not supported by hardware, test 2K / 1440p
          const factor2k = Math.min(2560 / maxWidth, 1440 / maxHeight);
          const w2k = Math.max(2, roundToMultipleOf2(Math.round(maxWidth * factor2k)));
          const h2k = Math.max(2, roundToMultipleOf2(Math.round(maxHeight * factor2k)));
          const probe2k = await probeHardwareResolutionSupport(
            options.codec || "av1",
            w2k,
            h2k,
            profile.maxBitrateHigh,
            options.fps,
          );

          if (probe2k.supported && (probe2k.hardware || !profile.isMobile)) {
            scaleFactor = factor2k;
            downscaleReason = `Hardware encoder limit (${w2k}×${h2k} 1440p)`;
          } else {
            // Fallback: 1080p safe mode
            scaleFactor = Math.min(1920 / maxWidth, 1080 / maxHeight);
            downscaleReason = "Device hardware limit (1080p safe mode)";
          }
        }
      }
    }
  }

  const bboxWidth = Math.max(2, roundToMultipleOf2(Math.round(maxWidth * scaleFactor)));
  const bboxHeight = Math.max(2, roundToMultipleOf2(Math.round(maxHeight * scaleFactor)));

  let downscaleReport: DownscaleReport | undefined;
  if (scaleFactor < 0.999) {
    downscaleReport = {
      originalWidth: maxWidth,
      originalHeight: maxHeight,
      scaledWidth: bboxWidth,
      scaledHeight: bboxHeight,
      scaleFactor,
      reason: downscaleReason || "Hardware adaptation",
    };
    onProgress(
      `Downscaled from ${maxWidth}×${maxHeight} to ${bboxWidth}×${bboxHeight} (${downscaleReport.reason})`,
      0,
      files.length,
    );
  }

  // Step 2: Configure WebCodecs VideoEncoder for chosen codec
  const codecFamily: CodecFamily = options.codec || "av1";
  const codecDisplayName = CODEC_DEFINITIONS[codecFamily]?.name || "Video";
  onProgress(`Configuring ${codecDisplayName} video encoder`, 0, files.length);

  const totalPixels = bboxWidth * bboxHeight;
  let targetBitrate: number;
  const bitrateMultiplier = codecFamily === "av1" ? 1.0 : 1.2;

  const maxBitrateCap = profile.isMobile
    ? options.quality === "lossless"
      ? profile.maxBitrateLossless
      : options.quality === "high"
        ? profile.maxBitrateHigh
        : profile.maxBitrateBalanced
    : options.quality === "lossless"
      ? profile.maxBitrateLossless
      : options.quality === "high"
        ? profile.maxBitrateHigh
        : profile.maxBitrateBalanced;

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
    downscaleReport,
  };
}
