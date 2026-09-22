// File System Access API utilities with graceful fallbacks and non-blocking traversal.

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

  const files: ImageFileInput[] = [];
  await traverseDirectoryHandle(dirHandle, "", files, onProgress);
  // Sort files naturally by filename
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  return files;
}

async function traverseDirectoryHandle(
  dirHandle: FileSystemDirectoryHandle,
  pathPrefix: string,
  out: ImageFileInput[],
  onProgress?: DiscoveryProgressCallback,
): Promise<void> {
  // @ts-expect-error async iterator on DirectoryHandle
  for await (const [name, handle] of dirHandle.entries()) {
    if (name.startsWith(".")) continue;
    if (handle.kind === "file") {
      if (isImageFile(name)) {
        const file = await (handle as FileSystemFileHandle).getFile();
        const filePath = pathPrefix ? `${pathPrefix}/${name}` : name;
        out.push({ name: filePath, file });
        onProgress?.(out.length, name);
        if (out.length % 25 === 0) {
          await new Promise((r) => setTimeout(r, 0));
        }
      }
    } else if (handle.kind === "directory") {
      await traverseDirectoryHandle(
        handle as FileSystemDirectoryHandle,
        pathPrefix ? `${pathPrefix}/${name}` : name,
        out,
        onProgress,
      );
    }
  }
}

/** Handles drag-and-drop data transfer items with live progress reporting. */
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
      for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        if (item.kind !== "file") continue;
        // @ts-expect-error getAsFileSystemHandle
        const handle = await item.getAsFileSystemHandle();
        if (!handle) continue;
        usedHandles = true;
        if (handle.kind === "directory") {
          await traverseDirectoryHandle(handle, "", imageFiles, onProgress);
        } else if (handle.kind === "file" && isImageFile(handle.name)) {
          const file = await (handle as FileSystemFileHandle).getFile();
          imageFiles.push({ name: file.name, file });
          onProgress?.(imageFiles.length, file.name);
        }
      }
    } catch {
      usedHandles = false;
    }
  }

  // Fallback to webkitGetAsEntry (standard for folder drag & drop in Chrome/Firefox/Safari)
  if (!usedHandles || imageFiles.length === 0) {
    const queue: Array<{ entry: any; pathPrefix: string }> = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
      if (entry) {
        queue.push({ entry, pathPrefix: "" });
      } else if (item.kind === "file") {
        const file = item.getAsFile();
        if (file && isImageFile(file.name)) {
          imageFiles.push({ name: file.name, file });
          onProgress?.(imageFiles.length, file.name);
        }
      }
    }

    while (queue.length > 0) {
      const { entry, pathPrefix } = queue.shift()!;
      if (entry.isFile) {
        await new Promise<void>((resolve) => {
          entry.file(
            (file: File) => {
              if (isImageFile(file.name)) {
                const filePath = pathPrefix ? `${pathPrefix}/${file.name}` : file.name;
                imageFiles.push({ name: filePath, file });
                onProgress?.(imageFiles.length, file.name);
              }
              resolve();
            },
            () => resolve(),
          );
        });
      } else if (entry.isDirectory) {
        const dirReader = entry.createReader();
        const readAllEntries = async () => {
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
        };
        await readAllEntries();
      }

      if (imageFiles.length % 25 === 0) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  }

  // Last resort fallback for browsers without webkitGetAsEntry
  if (imageFiles.length === 0 && dataTransfer.files.length > 0) {
    for (let i = 0; i < dataTransfer.files.length; i++) {
      const file = dataTransfer.files[i]!;
      if (isImageFile(file.name)) {
        imageFiles.push({ name: file.name, file });
        onProgress?.(imageFiles.length, file.name);
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
