// File System Access API utilities with high-performance concurrent batching.

export interface ImageFileInput {
  name: string;
  file: File;
}

export type DroppedContent =
  | { type: "video"; file: File }
  | { type: "images"; files: ImageFileInput[] };

const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "bmp",
  "gif",
  "avif",
]);

export function isImageFile(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return SUPPORTED_IMAGE_EXTENSIONS.has(ext);
}

export function isPackedVideoFile(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return ext === "mkv" || ext === "webm" || ext === "mp4";
}

export type DiscoveryProgressCallback = (count: number, currentName?: string) => void;

/**
 * Concurrently maps items using a pool of workers to eliminate sequential IPC latency.
 */
async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
  onProgress?: (completed: number, item: T) => void,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let currentIndex = 0;
  let completed = 0;

  const workerCount = Math.min(concurrency, items.length);
  if (workerCount === 0) return results;

  const workers = new Array(workerCount).fill(0).map(async () => {
    while (currentIndex < items.length) {
      const idx = currentIndex++;
      const item = items[idx]!;
      results[idx] = await fn(item);
      completed++;
      if (onProgress && (completed % 15 === 0 || completed === items.length)) {
        onProgress(completed, item);
      }
    }
  });

  await Promise.all(workers);
  return results;
}

/** Rapidly traverses directory handles collecting file handles without sequential getFile() calls. */
async function collectDirectoryHandles(
  dirHandle: FileSystemDirectoryHandle,
  pathPrefix: string,
  out: Array<{ name: string; handle: FileSystemFileHandle }>,
): Promise<void> {
  // @ts-expect-error async iterator on DirectoryHandle
  for await (const [name, handle] of dirHandle.entries()) {
    if (name.startsWith(".")) continue;
    if (handle.kind === "file") {
      if (isImageFile(name)) {
        out.push({
          name: pathPrefix ? `${pathPrefix}/${name}` : name,
          handle: handle as FileSystemFileHandle,
        });
      }
    } else if (handle.kind === "directory") {
      await collectDirectoryHandles(
        handle as FileSystemDirectoryHandle,
        pathPrefix ? `${pathPrefix}/${name}` : name,
        out,
      );
    }
  }
}

/** Prompts the user to pick a folder using the File System Access API. */
export async function pickDirectory(
  onProgress?: DiscoveryProgressCallback,
): Promise<ImageFileInput[]> {
  if (!("showDirectoryPicker" in window)) {
    throw new Error("Directory picker is not supported in this browser. Please drag and drop your folder instead.");
  }

  // @ts-expect-error window.showDirectoryPicker is experimental in standard lib.dom
  const dirHandle: FileSystemDirectoryHandle = await window.showDirectoryPicker({
    mode: "read",
  });

  onProgress?.(0, "Scanning directory structure...");
  const discoveredHandles: Array<{ name: string; handle: FileSystemFileHandle }> = [];
  await collectDirectoryHandles(dirHandle, "", discoveredHandles);

  onProgress?.(discoveredHandles.length, `Reading ${discoveredHandles.length} files...`);

  // Concurrently resolve File objects (pool of 40 parallel requests to bypass browser IPC bottleneck)
  const files = await mapConcurrent(
    discoveredHandles,
    40,
    async ({ name, handle }) => {
      const file = await handle.getFile();
      return { name, file };
    },
    (count, item) => onProgress?.(count, item.name),
  );

  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  return files;
}

/** Handles drag-and-drop data transfer items with high-throughput concurrent resolution. */
export async function handleDropEvent(
  dataTransfer: DataTransfer,
  onProgress?: DiscoveryProgressCallback,
): Promise<DroppedContent | null> {
  // 1. Check if a single video file was dropped
  if (dataTransfer.files.length === 1 && isPackedVideoFile(dataTransfer.files[0]!.name)) {
    return { type: "video", file: dataTransfer.files[0]! };
  }

  const items = dataTransfer.items;
  const imageFiles: ImageFileInput[] = [];

  // Try modern File System Access API handles first if available
  let usedHandles = false;
  if (items.length > 0 && "getAsFileSystemHandle" in items[0]!) {
    try {
      const discoveredHandles: Array<{ name: string; handle: FileSystemFileHandle }> = [];

      for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        if (item.kind !== "file") continue;
        // @ts-expect-error getAsFileSystemHandle
        const handle = await item.getAsFileSystemHandle();
        if (!handle) continue;
        usedHandles = true;
        if (handle.kind === "directory") {
          await collectDirectoryHandles(handle, "", discoveredHandles);
        } else if (handle.kind === "file" && isImageFile(handle.name)) {
          discoveredHandles.push({ name: handle.name, handle: handle as FileSystemFileHandle });
        }
      }

      if (discoveredHandles.length > 0) {
        onProgress?.(discoveredHandles.length, `Reading ${discoveredHandles.length} files...`);
        const resolved = await mapConcurrent(
          discoveredHandles,
          40,
          async ({ name, handle }) => {
            const file = await handle.getFile();
            return { name, file };
          },
          (count, item) => onProgress?.(count, item.name),
        );
        imageFiles.push(...resolved);
      }
    } catch {
      usedHandles = false;
    }
  }

  // Fallback to webkitGetAsEntry (standard for folder drag & drop in Chrome/Firefox/Safari)
  if (!usedHandles || imageFiles.length === 0) {
    const queue: Array<{ entry: any; pathPrefix: string }> = [];
    const discoveredEntries: Array<{ name: string; entry: any }> = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
      if (entry) {
        queue.push({ entry, pathPrefix: "" });
      } else if (item.kind === "file") {
        const file = item.getAsFile();
        if (file && isImageFile(file.name)) {
          imageFiles.push({ name: file.name, file });
        }
      }
    }

    // Fast directory tree traversal (pure entry names, no file reading yet)
    while (queue.length > 0) {
      const { entry, pathPrefix } = queue.shift()!;
      if (entry.isFile) {
        if (isImageFile(entry.name)) {
          discoveredEntries.push({
            name: pathPrefix ? `${pathPrefix}/${entry.name}` : entry.name,
            entry,
          });
        }
      } else if (entry.isDirectory) {
        const dirReader = entry.createReader();
        await new Promise<void>((resolve) => {
          const readBatch = () => {
            dirReader.readEntries(
              (entries: any[]) => {
                if (entries.length === 0) {
                  resolve();
                } else {
                  for (const sub of entries) {
                    queue.push({
                      entry: sub,
                      pathPrefix: pathPrefix ? `${pathPrefix}/${entry.name}` : entry.name,
                    });
                  }
                  readBatch();
                }
              },
              () => resolve(),
            );
          };
          readBatch();
        });
      }
    }

    // Concurrently resolve all discovered file entries in parallel
    if (discoveredEntries.length > 0) {
      onProgress?.(discoveredEntries.length, `Reading ${discoveredEntries.length} files...`);
      const resolved = await mapConcurrent(
        discoveredEntries,
        40,
        ({ name, entry }) =>
          new Promise<ImageFileInput | null>((resolve) => {
            entry.file(
              (file: File) => resolve({ name, file }),
              () => resolve(null),
            );
          }),
        (count, item) => onProgress?.(count, item.name),
      );

      for (const item of resolved) {
        if (item) imageFiles.push(item);
      }
    }
  }

  // Fast direct files fallback (when dragging multiple loose files without directory wrapper)
  if (imageFiles.length === 0 && dataTransfer.files.length > 0) {
    for (let i = 0; i < dataTransfer.files.length; i++) {
      const file = dataTransfer.files[i]!;
      if (isImageFile(file.name)) {
        imageFiles.push({ name: file.name, file });
      }
    }
  }

  if (imageFiles.length > 0) {
    imageFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    return { type: "images", files: imageFiles };
  }

  return null;
}

/** Saves a file via File System Access API or triggers download fallback. */
export async function saveFile(
  blob: Blob,
  suggestedName: string,
  description: string,
  mimeType: string,
  extension: string,
): Promise<void> {
  if ("showSaveFilePicker" in window) {
    try {
      // @ts-expect-error showSaveFilePicker
      const handle: FileSystemFileHandle = await window.showSaveFilePicker({
        suggestedName,
        types: [
          {
            description,
            accept: { [mimeType]: [`.${extension}`] },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (err: any) {
      if (err.name === "AbortError") return; // User cancelled
    }
  }

  // Anchor download fallback
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestedName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
