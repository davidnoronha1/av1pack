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
 * Supports instantaneous cancellation via AbortSignal.
 */
export async function encodeAlbumInWorker(
  files: ImageFileInput[],
  options: EncodeOptions,
  onProgress: ProgressCallback,
  signal?: AbortSignal,
): Promise<EncodeResult> {
  if (signal?.aborted) {
    throw new DOMException("Encoding cancelled", "AbortError");
  }

  const worker = new Worker(new URL("./encoder.worker.ts", import.meta.url), {
    type: "module",
  });

  const requestId = Math.random().toString(36).slice(2);

  return new Promise<EncodeResult>((resolve, reject) => {
    const onAbort = () => {
      worker.terminate();
      reject(new DOMException("Encoding cancelled", "AbortError"));
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    worker.onmessage = (e: MessageEvent) => {
      const { id, type, stage, current, total, result, error } = e.data;
      if (id !== requestId) return;

      if (type === "progress") {
        onProgress(stage, current, total);
      } else if (type === "success") {
        signal?.removeEventListener("abort", onAbort);
        worker.terminate();
        const webmBlob = new Blob([e.data.buffer], { type: "video/webm" });
        resolve({
          cleanBlob: webmBlob,
          exportBlob: webmBlob,
          metadata: e.data.metadata,
          bboxWidth: e.data.bboxWidth,
          bboxHeight: e.data.bboxHeight,
          durationSeconds: e.data.durationSeconds,
        });
      } else if (type === "error") {
        signal?.removeEventListener("abort", onAbort);
        worker.terminate();
        reject(new Error(error));
      }
    };

    worker.onerror = (e) => {
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      reject(new Error(e.message || "Unknown error occurred in encoder Web Worker"));
    };

    worker.onmessageerror = () => {
      signal?.removeEventListener("abort", onAbort);
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
  signal?: AbortSignal,
): Promise<EncodeResult> {
  return executeEncodePipeline(files, options, onProgress, signal);
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
  signal?: AbortSignal,
): Promise<EncodeResult> {
  if (signal?.aborted) {
    throw new DOMException("Encoding cancelled", "AbortError");
  }

  try {
    return await encodeAlbumInWorker(files, options, onProgress, signal);
  } catch (workerErr: any) {
    if (workerErr.name === "AbortError" || signal?.aborted) {
      throw workerErr;
    }
    console.warn("Worker encoding failed, falling back to main thread:", workerErr);
    return await encodeAlbumOnMainThread(files, options, onProgress, signal);
  }
}
