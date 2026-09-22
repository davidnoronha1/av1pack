import { signal, computed } from "@preact/signals";
import { Av1packModule } from "./wasm/loader";
import {
  pickDirectory,
  handleDropEvent,
  saveFile,
  type ImageFileInput,
} from "./fs-access";
import {
  encodeAlbum,
  type AlbumMetadata,
  type EncodeOptions,
} from "./video-encoder";
import { loadPackedVideo, type DecodedAlbum } from "./video-decoder";
import {
  detectAvailableCodecs,
  pickDefaultCodec,
  type AvailableCodec,
  type CodecFamily,
} from "./codecs";

export function formatBytes(bytes: number): string {
  if (bytes <= 0 || isNaN(bytes)) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val < 10 ? val.toFixed(2) : val.toFixed(1)} ${units[i]}`;
}

export type AppMode = "idle" | "processing" | "reader";

class AppController {
  // Application mode
  readonly mode = signal<AppMode>("idle");
  readonly statusMessage = signal<string>("Ready");
  readonly errorMessage = signal<string | null>(null);

  // Drag over drop zone state
  readonly isDragOver = signal<boolean>(false);

  // Size metrics
  readonly compressedSize = signal<number | null>(null);
  readonly originalSize = signal<number | null>(null);

  // Progress tracking
  readonly progressStage = signal<string>("");
  readonly progressCurrent = signal<number>(0);
  readonly progressTotal = signal<number>(0);
  readonly progressEta = signal<string>("");
  readonly progressPercent = computed(() => {
    if (this.progressTotal.value <= 0) return 0;
    return Math.min(
      100,
      Math.round((this.progressCurrent.value / this.progressTotal.value) * 100),
    );
  });

  private stageStartTime = 0;
  private lastStageName = "";

  updateProgress(stage: string, current: number, total: number): void {
    const now = performance.now();
    if (stage !== this.lastStageName) {
      this.lastStageName = stage;
      this.stageStartTime = now;
      this.progressEta.value = "";
    }

    this.progressStage.value = stage;
    this.progressCurrent.value = current;
    this.progressTotal.value = total;

    if (total > 0 && current > 0) {
      const elapsedSec = (now - this.stageStartTime) / 1000;
      if (elapsedSec > 0.6 && current < total) {
        const itemsPerSec = current / elapsedSec;
        const remainingItems = total - current;
        const remainingSec = remainingItems / itemsPerSec;

        let etaStr = "";
        if (remainingSec < 60) {
          etaStr = `~${Math.round(remainingSec)}s remaining`;
        } else {
          const m = Math.floor(remainingSec / 60);
          const s = Math.round(remainingSec % 60);
          etaStr = `~${m}m ${s}s remaining`;
        }

        const isFrames = stage.toLowerCase().includes("frame");
        const speedStr =
          itemsPerSec >= 1
            ? `${itemsPerSec.toFixed(1)} ${isFrames ? "fps" : "items/s"}`
            : `${(1 / itemsPerSec).toFixed(1)} s/${isFrames ? "frame" : "item"}`;

        this.progressEta.value = `${etaStr} • ${speedStr}`;
      } else if (current >= total) {
        this.progressEta.value = "Finalizing...";
      }
    }
  }

  // Encoding options
  readonly quality = signal<"lossless" | "high" | "balanced">("lossless");
  readonly availableCodecs = signal<AvailableCodec[]>([]);
  readonly selectedCodec = signal<CodecFamily>("av1");

  // Exportable blob (with trailer metadata)
  private lastExportBlob: Blob | null = null;

  // Reader state
  readonly decodedAlbum = signal<DecodedAlbum | null>(null);
  readonly currentFrame = signal<number>(0);
  readonly isPlaying = signal<boolean>(false);
  readonly isZipping = signal<boolean>(false);

  // WASM module instance for reader & zip creation
  wasm: Av1packModule | null = null;
  private slideshowTimer: any = null;

  async init(): Promise<void> {
    try {
      const codecs = await detectAvailableCodecs();
      this.availableCodecs.value = codecs;
      const autoPicked = pickDefaultCodec(codecs);
      this.selectedCodec.value = autoPicked;
    } catch (e) {
      console.warn("Codec detection failed:", e);
    }

    try {
      this.wasm = await Av1packModule.load("/src/wasm/av1pack.wasm");
    } catch {
      try {
        const wasmUrl = new URL("./wasm/av1pack.wasm", import.meta.url).href;
        this.wasm = await Av1packModule.load(wasmUrl);
      } catch (err: any) {
        console.warn("Main thread WASM initialization deferred:", err);
      }
    }
  }

  /** Triggers File System Access folder selection and begins packing. */
  async selectFolder(): Promise<void> {
    this.errorMessage.value = null;
    try {
      this.mode.value = "processing";
      this.progressStage.value = "Scanning folder...";
      this.progressCurrent.value = 0;
      this.progressTotal.value = 0;

      const files = await pickDirectory((count, name) => {
        this.progressStage.value = `Found ${count} image${count === 1 ? "" : "s"}${name ? ` (${name})` : ""}...`;
      });

      if (files.length === 0) {
        this.mode.value = "idle";
        this.errorMessage.value = "No supported image files found in the selected folder.";
        return;
      }
      await this.processImages(files);
    } catch (err: any) {
      this.mode.value = "idle";
      if (err.name === "AbortError") return;
      this.errorMessage.value = err?.message || String(err);
    }
  }

  /** Triggers single packed video selection. */
  async selectPackedFile(file: File): Promise<void> {
    this.errorMessage.value = null;
    this.mode.value = "processing";
    this.progressStage.value = "Loading packed video file";
    this.progressCurrent.value = 50;
    this.progressTotal.value = 100;

    try {
      this.lastExportBlob = file;
      this.compressedSize.value = file.size;
      this.originalSize.value = null;
      const album = await loadPackedVideo(file);
      this.setDecodedAlbum(album);
    } catch (err: any) {
      this.mode.value = "idle";
      this.errorMessage.value = `Failed to unpack video: ${err?.message || err}`;
    }
  }

  /** Loads the built-in Wikipedia example dataset and packs it into AV1. */
  async loadWikipediaExample(): Promise<void> {
    this.errorMessage.value = null;
    this.mode.value = "processing";
    this.progressStage.value = "Loading Wikipedia sample images";
    this.progressCurrent.value = 0;
    this.progressTotal.value = 6;

    const sampleNames = [
      "01_aurora.jpg",
      "02_grand_canyon.jpg",
      "03_matterhorn.jpg",
      "04_monarch_butterfly.jpg",
      "05_red_panda.jpg",
      "06_mount_fuji.jpg",
    ];

    try {
      const imageInputs: ImageFileInput[] = [];
      for (let i = 0; i < sampleNames.length; i++) {
        const name = sampleNames[i]!;
        this.progressStage.value = `Loading Wikipedia dataset (${i + 1}/${sampleNames.length})`;
        this.progressCurrent.value = i + 1;
        const res = await fetch(`/wikipedia-example/${name}`);
        if (!res.ok) throw new Error(`Failed to load ${name} (${res.status})`);
        const blob = await res.blob();
        const file = new File([blob], name, { type: blob.type || "image/jpeg" });
        imageInputs.push({ file, name });
      }

      await this.processImages(imageInputs);
    } catch (err: any) {
      this.mode.value = "idle";
      this.errorMessage.value = `Failed to load Wikipedia example: ${err?.message || err}`;
    }
  }

  /** Handles drop of folder or files onto the drop zone with immediate visual feedback. */
  async handleDrop(dataTransfer: DataTransfer): Promise<void> {
    this.isDragOver.value = false;
    this.errorMessage.value = null;

    // Provide immediate visual feedback on drop
    this.mode.value = "processing";
    this.progressStage.value = "Scanning dropped files...";
    this.progressCurrent.value = 0;
    this.progressTotal.value = 0;

    try {
      const content = await handleDropEvent(dataTransfer, (count, name) => {
        this.progressStage.value = `Scanning files: found ${count} image${count === 1 ? "" : "s"}${name ? ` (${name})` : ""}...`;
      });

      if (!content) {
        this.mode.value = "idle";
        this.errorMessage.value = "No valid images or packed video found in dropped item.";
        return;
      }

      if (content.type === "video") {
        await this.selectPackedFile(content.file);
      } else {
        await this.processImages(content.files);
      }
    } catch (err: any) {
      this.mode.value = "idle";
      this.errorMessage.value = err?.message || String(err);
    }
  }

  /** Encodes image files to video in a Web Worker and transitions into reader mode. */
  private async processImages(files: ImageFileInput[]): Promise<void> {
    const totalOriginalSize = files.reduce((acc, f) => acc + (f.file?.size || 0), 0);
    this.originalSize.value = totalOriginalSize > 0 ? totalOriginalSize : null;

    this.mode.value = "processing";
    this.progressStage.value = "Preparing images";
    this.progressCurrent.value = 0;
    this.progressTotal.value = files.length;

    try {
      const options: EncodeOptions = {
        fps: 30,
        quality: this.quality.value,
        codec: this.selectedCodec.value,
      };

      // Ensure main thread WASM is ready for reader mode later
      if (!this.wasm) {
        await this.init();
      }

      const result = await encodeAlbum(
        files,
        options,
        this.wasm!,
        (stage, cur, tot) => {
          this.updateProgress(stage, cur, tot);
        },
      );

      this.lastExportBlob = result.exportBlob;
      this.compressedSize.value = result.exportBlob.size;

      // Immediately load clean WebM stream into reader
      this.progressStage.value = "Opening in frame reader";
      const album = await loadPackedVideo(result.cleanBlob, result.metadata);
      this.setDecodedAlbum(album);
    } catch (err: any) {
      this.mode.value = "idle";
      this.errorMessage.value = `Encoding failed: ${err?.message || err}`;
      console.error("Encoding error:", err);
    }
  }

  private setDecodedAlbum(album: DecodedAlbum): void {
    if (this.decodedAlbum.value) {
      this.decodedAlbum.value.cleanup();
    }
    this.decodedAlbum.value = album;
    if (this.compressedSize.value === null && album.fileSize) {
      this.compressedSize.value = album.fileSize;
    }
    this.currentFrame.value = 0;
    this.mode.value = "reader";
    this.stopSlideshow();
  }

  nextFrame(): void {
    const album = this.decodedAlbum.value;
    if (!album) return;
    if (this.currentFrame.value < album.totalFrames - 1) {
      this.currentFrame.value += 1;
    } else {
      this.currentFrame.value = 0; // Loop around
    }
  }

  prevFrame(): void {
    const album = this.decodedAlbum.value;
    if (!album) return;
    if (this.currentFrame.value > 0) {
      this.currentFrame.value -= 1;
    } else {
      this.currentFrame.value = album.totalFrames - 1;
    }
  }

  goToFrame(index: number): void {
    const album = this.decodedAlbum.value;
    if (!album) return;
    const clamped = Math.max(0, Math.min(index, album.totalFrames - 1));
    this.currentFrame.value = clamped;
  }

  toggleSlideshow(): void {
    if (this.isPlaying.value) {
      this.stopSlideshow();
    } else {
      this.startSlideshow();
    }
  }

  private startSlideshow(): void {
    this.isPlaying.value = true;
    this.slideshowTimer = setInterval(() => {
      this.nextFrame();
    }, 1200);
  }

  private stopSlideshow(): void {
    this.isPlaying.value = false;
    if (this.slideshowTimer) {
      clearInterval(this.slideshowTimer);
      this.slideshowTimer = null;
    }
  }

  /** Extracts all unpadded frames and builds a ZIP archive using Zig std.zip. */
  async downloadZip(): Promise<void> {
    const album = this.decodedAlbum.value;
    if (!album) return;
    if (!this.wasm) {
      await this.init();
    }
    if (!this.wasm) {
      alert("Zig WASM core not available for ZIP packing.");
      return;
    }

    this.isZipping.value = true;
    const prevStage = this.progressStage.value;

    try {
      const extractedFiles = await album.extractAllFrames(
        this.wasm,
        (stage, cur, tot) => {
          this.updateProgress(stage, cur, tot);
        },
      );

      this.progressStage.value = "Creating ZIP archive in Zig WASM...";
      this.progressEta.value = "";
      await new Promise((r) => setTimeout(r, 10)); // allow UI render

      const zipBytes = this.wasm.createZip(extractedFiles);
      const zipBlob = new Blob([zipBytes.buffer as ArrayBuffer], { type: "application/zip" });

      await saveFile(
        zipBlob,
        "album_unpacked.zip",
        "ZIP Archive",
        "application/zip",
        "zip",
      );
    } catch (err: any) {
      alert(`Failed to create ZIP: ${err?.message || err}`);
    } finally {
      this.isZipping.value = false;
      this.progressStage.value = prevStage;
      this.progressEta.value = "";
    }
  }

  /** Saves the packed video file to the file system. */
  async exportVideo(): Promise<void> {
    const album = this.decodedAlbum.value;
    if (!album) return;

    const blobToExport = this.lastExportBlob ?? album.cleanBlob;

    await saveFile(
      blobToExport,
      "album_packed.webm",
      "Packed AV1 Video",
      "video/webm",
      "webm",
    );
  }

  reset(): void {
    this.stopSlideshow();
    if (this.decodedAlbum.value) {
      this.decodedAlbum.value.cleanup();
      this.decodedAlbum.value = null;
    }
    this.lastExportBlob = null;
    this.compressedSize.value = null;
    this.originalSize.value = null;
    this.currentFrame.value = 0;
    this.mode.value = "idle";
    this.errorMessage.value = null;
    this.progressEta.value = "";
    this.stageStartTime = 0;
    this.lastStageName = "";
  }
}

export const app = new AppController();
