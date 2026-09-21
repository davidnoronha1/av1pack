// File System Access API utilities with graceful fallbacks.

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

function isImageFile(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return SUPPORTED_IMAGE_EXTENSIONS.has(ext);
}

function isPackedVideoFile(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return ext === "mkv" || ext === "webm" || ext === "mp4";
}

/** Prompts the user to pick a folder using the File System Access API. */
export async function pickDirectory(): Promise<ImageFileInput[]> {
  if (!("showDirectoryPicker" in window)) {
    throw new Error("Directory picker is not supported in this browser. Please drag and drop your folder instead.");
  }

  // @ts-expect-error window.showDirectoryPicker is experimental in standard lib.dom
  const dirHandle: FileSystemDirectoryHandle = await window.showDirectoryPicker({
    mode: "read",
  });

  const files: ImageFileInput[] = [];
  await traverseDirectoryHandle(dirHandle, "", files);
  // Sort files naturally by filename
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  return files;
}

async function traverseDirectoryHandle(
  dirHandle: FileSystemDirectoryHandle,
  pathPrefix: string,
  out: ImageFileInput[],
): Promise<void> {
  // @ts-expect-error async iterator on DirectoryHandle
  for await (const [name, handle] of dirHandle.entries()) {
    if (name.startsWith(".")) continue;
    if (handle.kind === "file") {
      if (isImageFile(name)) {
        const file = await (handle as FileSystemFileHandle).getFile();
        out.push({
          name: pathPrefix ? `${pathPrefix}/${name}` : name,
          file,
        });
      }
    } else if (handle.kind === "directory") {
      await traverseDirectoryHandle(
        handle as FileSystemDirectoryHandle,
        pathPrefix ? `${pathPrefix}/${name}` : name,
        out,
      );
    }
  }
}

/** Handles drag-and-drop data transfer items, traversing directories and files. */
export async function handleDropEvent(
  dataTransfer: DataTransfer,
): Promise<DroppedContent | null> {
  // 1. Check if a single video file was dropped
  if (dataTransfer.files.length === 1 && isPackedVideoFile(dataTransfer.files[0]!.name)) {
    return { type: "video", file: dataTransfer.files[0]! };
  }

  const items = dataTransfer.items;
  const imageFiles: ImageFileInput[] = [];

  // Try File System Access API handles first
  const handlePromises: Promise<void>[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.kind !== "file") continue;

    if ("getAsFileSystemHandle" in item) {
      handlePromises.push(
        (async () => {
          try {
            // @ts-expect-error getAsFileSystemHandle
            const handle = await item.getAsFileSystemHandle();
            if (!handle) return;
            if (handle.kind === "directory") {
              await traverseDirectoryHandle(handle, "", imageFiles);
            } else if (handle.kind === "file" && isImageFile(handle.name)) {
              const file = await (handle as FileSystemFileHandle).getFile();
              imageFiles.push({ name: file.name, file });
            }
          } catch {
            // Fallback will catch below
          }
        })(),
      );
    }
  }

  if (handlePromises.length > 0) {
    await Promise.all(handlePromises);
  }

  // If no handles worked or none present, fallback to webkitGetAsEntry or files
  if (imageFiles.length === 0) {
    const entryPromises: Promise<void>[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
      if (entry) {
        entryPromises.push(traverseWebkitEntry(entry, "", imageFiles));
      } else if (item.kind === "file") {
        const file = item.getAsFile();
        if (file && isImageFile(file.name)) {
          imageFiles.push({ name: file.name, file });
        }
      }
    }
    if (entryPromises.length > 0) {
      await Promise.all(entryPromises);
    }
  }

  if (imageFiles.length > 0) {
    imageFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    return { type: "images", files: imageFiles };
  }

  return null;
}

function traverseWebkitEntry(
  entry: any,
  pathPrefix: string,
  out: ImageFileInput[],
): Promise<void> {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file((file: File) => {
        if (isImageFile(file.name)) {
          out.push({
            name: pathPrefix ? `${pathPrefix}/${file.name}` : file.name,
            file,
          });
        }
        resolve();
      }, () => resolve());
    } else if (entry.isDirectory) {
      const dirReader = entry.createReader();
      const readEntries = () => {
        dirReader.readEntries(async (entries: any[]) => {
          if (entries.length === 0) {
            resolve();
          } else {
            const subPromises = entries.map((e) =>
              traverseWebkitEntry(
                e,
                pathPrefix ? `${pathPrefix}/${entry.name}` : entry.name,
                out,
              ),
            );
            await Promise.all(subPromises);
            readEntries();
          }
        }, () => resolve());
      };
      readEntries();
    } else {
      resolve();
    }
  });
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
      // Other error: fallback to anchor download
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
