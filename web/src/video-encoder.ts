import { Muxer, ArrayBufferTarget } from "webm-muxer";
import type { Av1packModule } from "./wasm/loader";
import type { ImageFileInput } from "./fs-access";
import { gzipCompress } from "./gzip";

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

const AV1_CODEC_CANDIDATES = [
  "av01.0.08M.10",
  "av01.0.04M.08",
  "av01.0.05M.08",
  "av01.0.00M.08",
];

async function selectSupportedAv1Codec(
  width: number,
  height: number,
  bitrate: number,
  framerate: number,
): Promise<string> {
  for (const codec of AV1_CODEC_CANDIDATES) {
    const config: VideoEncoderConfig = {
      codec,
      width,
      height,
      bitrate,
      framerate,
      bitrateMode: "variable",
    };
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (support.supported) return codec;
    } catch {
      // Continue to next candidate
    }
  }
  throw new Error(
    "Browser does not support AV1 video encoding at this resolution. Please verify WebCodecs AV1 support.",
  );
}

/** Encodes image files exclusively using the AV1 codec in a WebM container. */
export async function encodeAlbum(
  files: ImageFileInput[],
  options: EncodeOptions,
  wasm: Av1packModule,
  onProgress: ProgressCallback,
): Promise<EncodeResult> {
  if (files.length === 0) throw new Error("No images provided to encode");

  // Step 1: Scan dimensions and determine common bounding box
  onProgress("Scanning dimensions & bounding box", 0, files.length);

  let maxWidth = 0;
  let maxHeight = 0;
  const metadata: AlbumMetadata = {};

  const tempCanvas = document.createElement("canvas");
  const tempCtx = tempCanvas.getContext("2d", { willReadFrequently: true })!;

  for (let i = 0; i < files.length; i++) {
    const item = files[i]!;
    const bitmap = await createImageBitmap(item.file);
    const width = bitmap.width;
    const height = bitmap.height;

    maxWidth = Math.max(maxWidth, width);
    maxHeight = Math.max(maxHeight, height);

    tempCanvas.width = width;
    tempCanvas.height = height;
    tempCtx.drawImage(bitmap, 0, 0);
    const imgData = tempCtx.getImageData(0, 0, width, height);
    const hasAlpha = checkHasAlpha(imgData.data);
    bitmap.close();

    metadata[i.toString()] = {
      filename: item.name,
      width,
      height,
      has_alpha: hasAlpha,
    };

    onProgress("Scanning dimensions & bounding box", i + 1, files.length);
  }

  const bboxWidth = roundToMultipleOf2(maxWidth);
  const bboxHeight = roundToMultipleOf2(maxHeight);

  // Step 2: Configure WebCodecs VideoEncoder for AV1
  onProgress("Initializing AV1 video encoder", 0, files.length);

  const totalPixels = bboxWidth * bboxHeight;
  let targetBitrate: number;
  if (options.quality === "lossless") {
    targetBitrate = Math.max(25_000_000, Math.round(totalPixels * options.fps * 0.45));
  } else if (options.quality === "high") {
    targetBitrate = Math.max(15_000_000, Math.round(totalPixels * options.fps * 0.25));
  } else {
    targetBitrate = Math.max(8_000_000, Math.round(totalPixels * options.fps * 0.15));
  }

  const av1Codec = await selectSupportedAv1Codec(
    bboxWidth,
    bboxHeight,
    targetBitrate,
    options.fps,
  );

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: {
      codec: "V_AV1",
      width: bboxWidth,
      height: bboxHeight,
      frameRate: options.fps,
    },
    firstTimestampBehavior: "offset",
  });

  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      muxer.addVideoChunk(chunk, meta);
    },
    error: (e) => {
      console.error("VideoEncoder error:", e);
    },
  });

  encoder.configure({
    codec: av1Codec,
    width: bboxWidth,
    height: bboxHeight,
    bitrate: targetBitrate,
    framerate: options.fps,
    bitrateMode: "variable",
  });

  // Step 3: Pad each image using Zig WASM and feed to VideoEncoder
  const paddedCanvas = document.createElement("canvas");
  paddedCanvas.width = bboxWidth;
  paddedCanvas.height = bboxHeight;
  const paddedCtx = paddedCanvas.getContext("2d", { willReadFrequently: true })!;

  const frameDurationUs = Math.round(1_000_000 / options.fps);

  for (let i = 0; i < files.length; i++) {
    const item = files[i]!;
    const meta = metadata[i.toString()]!;

    const bitmap = await createImageBitmap(item.file);
    tempCanvas.width = meta.width;
    tempCanvas.height = meta.height;
    tempCtx.drawImage(bitmap, 0, 0);
    const srcImageData = tempCtx.getImageData(0, 0, meta.width, meta.height);
    bitmap.close();

    const paddedImageData = wasm.padImage(
      srcImageData.data,
      meta.width,
      meta.height,
      bboxWidth,
      bboxHeight,
      meta.has_alpha ? [0, 0, 0, 0] : [0, 0, 0, 255],
    );

    paddedCtx.putImageData(paddedImageData, 0, 0);

    const timestamp = i * frameDurationUs;
    const videoFrame = new VideoFrame(paddedCanvas, {
      timestamp,
      duration: frameDurationUs,
    });

    const keyFrame = i === 0 || i % 30 === 0;
    encoder.encode(videoFrame, { keyFrame });
    videoFrame.close();

    onProgress("Encoding AV1 frames", i + 1, files.length);
  }

  // Step 4: Flush encoder and finalize muxer
  onProgress("Finalizing AV1 WebM video", files.length, files.length);
  await encoder.flush();
  encoder.close();
  muxer.finalize();

  const videoBuffer = target.buffer;

  // Clean WebM video blob for browser <video> player
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
