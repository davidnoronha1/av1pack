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
 * Recursively traverses a FileSystemDirectoryHandle and gathers image files directly.
 */
async function walkDirectoryHandle(
  dirHandle: FileSystemDirectoryHandle,
  pathPrefix: string,
  out: ImageFileInput[],
  onProgress?: DiscoveryProgressCallback,
): Promise<void> {
  // @ts-expect-error async iterator on DirectoryHandle
  for await (const [name, handle] of dirHandle.entries()) {
    if (name.startsWith(".")) continue;
    const itemPath = pathPrefix ? `${pathPrefix}/${name}` : name;

    if (handle.kind === "file" && isImageFile(name)) {
      const file = await (handle as FileSystemFileHandle).getFile();
      out.push({ name: itemPath, file });
      if (out.length % 10 === 0 || out.length === 1) {
        onProgress?.(out.length, name);
      }
    } else if (handle.kind === "directory") {
      await walkDirectoryHandle(
        handle as FileSystemDirectoryHandle,
        itemPath,
        out,
        onProgress,
      );
    }
  }
}

/**
 * Recursively reads all entries from a webkit directory entry.
 */
async function walkFileSystemEntry(
  entry: any,
  pathPrefix: string,
  out: ImageFileInput[],
  onProgress?: DiscoveryProgressCallback,
): Promise<void> {
  if (entry.isFile) {
    if (isImageFile(entry.name)) {
      await new Promise<void>((resolve) => {
        entry.file((file: File) => {
          out.push({ name: pathPrefix ? `${pathPrefix}/${entry.name}` : entry.name, file });
          if (out.length % 10 === 0 || out.length === 1) {
            onProgress?.(out.length, entry.name);
          }
          resolve();
        }, () => resolve());
      });
    }
  } else if (entry.isDirectory) {
    const dirReader = entry.createReader();
    const currentPrefix = pathPrefix ? `${pathPrefix}/${entry.name}` : entry.name;

    const readBatch = async (): Promise<void> => {
      const entries: any[] = await new Promise((resolve) => {
        dirReader.readEntries((results: any[]) => resolve(results), () => resolve([]));
      });
      if (entries.length > 0) {
        for (const subEntry of entries) {
          await walkFileSystemEntry(subEntry, currentPrefix, out, onProgress);
        }
        await readBatch();
      }
    };
    await readBatch();
  }
}

/**
 * Prompts the user to pick a folder using the File System Access API.
 */
export async function pickDirectory(
  onProgress?: DiscoveryProgressCallback,
): Promise<ImageFileInput[]> {
  if (!("showDirectoryPicker" in window)) {
    throw new Error(
      "Directory picker is not supported in this browser. Please drag and drop your folder instead.",
    );
  }

  // @ts-expect-error window.showDirectoryPicker
  const dirHandle: FileSystemDirectoryHandle = await window.showDirectoryPicker({
    mode: "read",
  });

  onProgress?.(0, "Scanning directory...");
  const files: ImageFileInput[] = [];
  await walkDirectoryHandle(dirHandle, "", files, onProgress);

  files.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
  );
  return files;
}

/**
 * Directly processes drag-and-drop events for dropped video files, folders, or multiple files.
 */
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

  // 2. Directory or item traversal via standard webkitGetAsEntry
  if (items && items.length > 0) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
      if (entry) {
        await walkFileSystemEntry(entry, "", imageFiles, onProgress);
      } else if (item.kind === "file") {
        const file = item.getAsFile();
        if (file && isImageFile(file.name)) {
          imageFiles.push({ name: file.name, file });
        }
      }
    }
  }

  // 3. Fallback to direct files array if items were unavailable
  if (imageFiles.length === 0 && dataTransfer.files.length > 0) {
    for (let i = 0; i < dataTransfer.files.length; i++) {
      const file = dataTransfer.files[i]!;
      if (isImageFile(file.name)) {
        imageFiles.push({ name: file.name, file });
      }
    }
  }

  if (imageFiles.length > 0) {
    imageFiles.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
    );
    return { type: "images", files: imageFiles };
  }

  return null;
}

/**
 * Saves a file via the File System Access API or triggers anchor download fallback.
 */
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
