import type { ImageFileInput } from "./fs-access";
import {
  executeEncodePipeline,
  type AlbumMetadata,
  type AlbumMetadataItem,
  type EncodeOptions,
  type EncodeResult,
  type ProgressCallback,
} from "./encoder-core";

export type { AlbumMetadata, AlbumMetadataItem, EncodeOptions, EncodeResult, ProgressCallback };

/**
 * Runs the encoding pipeline inside a dedicated Web Worker,
 * keeping the main browser thread free and responsive.
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
 * Fallback encoding execution directly on the main thread using the shared pipeline.
 */
export async function encodeAlbumOnMainThread(
  files: ImageFileInput[],
  options: EncodeOptions,
  onProgress: ProgressCallback,
): Promise<EncodeResult> {
  return executeEncodePipeline(files, options, onProgress);
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
