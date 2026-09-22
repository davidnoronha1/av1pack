import { Muxer, ArrayBufferTarget } from "webm-muxer";
import { gzipCompress } from "./gzip";
import { fastGetImageDimensions } from "./fast-dimensions";
import { CODEC_DEFINITIONS, type CodecFamily } from "./codecs";
import type { AlbumMetadata, EncodeOptions, EncodeResult } from "./video-encoder";
import type { ImageFileInput } from "./fs-access";

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
  if (typeof VideoEncoder === "undefined") {
    throw new Error("WebCodecs VideoEncoder is not available in worker context.");
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
        // Continue to next candidate
      }
    }
  }
  throw new Error(
    `Browser does not support ${def.name} video encoding at this resolution. Please verify WebCodecs ${def.name} support.`,
  );
}

export async function runEncodingInWorker(
  files: ImageFileInput[],
  options: EncodeOptions,
  onProgress: (stage: string, current: number, total: number) => void,
): Promise<EncodeResult> {
  if (files.length === 0) throw new Error("No images provided to encode");

  // Step 1: Rapid dimension scan
  onProgress("Scanning image dimensions", 0, files.length);
  let maxWidth = 0;
  let maxHeight = 0;
  const dimensions = new Array<{ width: number; height: number }>(files.length);

  for (let i = 0; i < files.length; i++) {
    const dims = await fastGetImageDimensions(files[i]!.file);
    dimensions[i] = dims;
    if (dims.width > maxWidth) maxWidth = dims.width;
    if (dims.height > maxHeight) maxHeight = dims.height;

    if (i % 10 === 0 || i === files.length - 1) {
      onProgress("Scanning image dimensions", i + 1, files.length);
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
  const bitrateMultiplier = codecFamily === "av1" ? 1.0 : 1.2; // slight bump for VP9/VP8

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
      console.error("Worker VideoEncoder error:", e);
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
  const tempCanvas = new OffscreenCanvas(bboxWidth, bboxHeight);
  const tempCtx = tempCanvas.getContext("2d", { willReadFrequently: true })!;

  const paddedCanvas = new OffscreenCanvas(bboxWidth, bboxHeight);
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

    // Backpressure control: prevent unbounded queue growth when encoding many images
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
      onProgress(`Encoding ${codecDisplayName} frames in worker`, i + 1, files.length);
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

self.onmessage = async (e: MessageEvent) => {
  const { id, type, files, options } = e.data;
  if (type === "encode") {
    try {
      const result = await runEncodingInWorker(
        files,
        options,
        (stage, current, total) => {
          self.postMessage({ id, type: "progress", stage, current, total });
        },
      );
      self.postMessage({ id, type: "success", result });
    } catch (err: any) {
      self.postMessage({ id, type: "error", error: err?.message || String(err) });
    }
  }
};
