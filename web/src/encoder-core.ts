import { Muxer, ArrayBufferTarget, SubtitleEncoder } from "webm-muxer";
import { gzipCompress } from "./gzip";
import { fastGetImageDimensions } from "./fast-dimensions";
import { CODEC_DEFINITIONS, type CodecFamily } from "./codecs";
import type { ImageFileInput } from "./fs-access";

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
): Promise<EncodeResult> {
  if (files.length === 0) throw new Error("No images provided to encode");

  // Step 1: Rapid dimension scan & alpha detection directly from file headers
  onProgress("Scanning image dimensions & headers", 0, files.length);

  let maxWidth = 0;
  let maxHeight = 0;
  const imageInfo = new Array<{ width: number; height: number; hasAlpha: boolean }>(files.length);

  for (let i = 0; i < files.length; i++) {
    const dims = await fastGetImageDimensions(files[i]!.file);
    const hasAlpha = dims.hasAlpha ?? false;
    imageInfo[i] = { width: dims.width, height: dims.height, hasAlpha };
    if (dims.width > maxWidth) maxWidth = dims.width;
    if (dims.height > maxHeight) maxHeight = dims.height;

    if (i % 10 === 0 || i === files.length - 1) {
      onProgress("Scanning image dimensions & headers", i + 1, files.length);
    }
  }

  const bboxWidth = roundToMultipleOf2(maxWidth);
  const bboxHeight = roundToMultipleOf2(maxHeight);

  // Step 2: Configure WebCodecs VideoEncoder for chosen codec
  const codecFamily: CodecFamily = options.codec || "av1";
  const codecDisplayName = CODEC_DEFINITIONS[codecFamily]?.name || "Video";
  onProgress(`Configuring ${codecDisplayName} video encoder`, 0, files.length);

  const totalPixels = bboxWidth * bboxHeight;
  let targetBitrate: number;
  const bitrateMultiplier = codecFamily === "av1" ? 1.0 : 1.2;

  if (options.quality === "lossless") {
    targetBitrate = Math.max(
      25_000_000,
      Math.round(totalPixels * options.fps * 0.45 * bitrateMultiplier),
    );
  } else if (options.quality === "high") {
    targetBitrate = Math.max(
      15_000_000,
      Math.round(totalPixels * options.fps * 0.25 * bitrateMultiplier),
    );
  } else {
    targetBitrate = Math.max(
      8_000_000,
      Math.round(totalPixels * options.fps * 0.15 * bitrateMultiplier),
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

    const item = files[i]!;
    const info = imageInfo[i]!;
    const width = info.width;
    const height = info.height;
    const hasAlpha = info.hasAlpha;

    metadata[i.toString()] = {
      filename: item.name,
      width,
      height,
      has_alpha: hasAlpha,
    };

    // Emit in-container WebVTT timed metadata cue for this frame
    const startMs = Math.round((i / options.fps) * 1000);
    const endMs = startMs + frameDurationMs;
    const cuePayload = JSON.stringify({
      filename: item.name,
      width,
      height,
      has_alpha: hasAlpha,
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

    if (width === bboxWidth && height === bboxHeight && !hasAlpha) {
      // Zero-copy direct fast-path: image already matches bounding box.
      // Pass the GPU texture directly into VideoFrame without intermediate canvas blitting.
      videoFrame = new VideoFrame(bitmap, {
        timestamp,
        duration: frameDurationUs,
      });
      bitmap.close();
    } else {
      // Padding path: allocate canvas on-demand and pad
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
      paddedCtx.drawImage(bitmap, 0, 0);
      bitmap.close();

      videoFrame = new VideoFrame(paddedCanvas as CanvasImageSource, {
        timestamp,
        duration: frameDurationUs,
      });
    }

    const keyFrame = i === 0 || i % 10 === 0;
    encoder.encode(videoFrame, { keyFrame });
    videoFrame.close();

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

  // Step 5: Append metadata trailer as dual fallback for zero-latency instant reads
  const metaJsonBytes = new TextEncoder().encode(JSON.stringify(metadata));
  const compressedMeta = await gzipCompress(metaJsonBytes);

  const totalByteLength = videoBuffer.byteLength + compressedMeta.length + 8 + 4;
  const combined = new Uint8Array(totalByteLength);
  combined.set(new Uint8Array(videoBuffer), 0);
  combined.set(compressedMeta, videoBuffer.byteLength);

  // 8-byte trailer magic: "AV1PACK\0"
  const magicOffset = videoBuffer.byteLength + compressedMeta.length;
  combined.set([0x41, 0x56, 0x31, 0x50, 0x41, 0x43, 0x4b, 0x00], magicOffset);

  // 4-byte metadata length (uint32 little-endian)
  const view = new DataView(combined.buffer, combined.byteOffset, combined.byteLength);
  view.setUint32(magicOffset + 8, compressedMeta.length, true);

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
