import { signal, computed } from "@preact/signals";
import {
  pickDirectory,
  handleDropEvent,
  saveFile,
  type ImageFileInput,
} from "./fs-access";
import { encodeAlbum, type EncodeOptions } from "./video-encoder";
import type { MaxResolution } from "./encoder-core";
import { loadPackedVideo, type DecodedAlbum } from "./video-decoder";
import {
  detectAvailableCodecs,
  pickDefaultCodec,
  type AvailableCodec,
  type CodecFamily,
} from "./codecs";
import { createZip } from "./zip";

export function formatBytes(bytes: number): string {
  if (bytes <= 0 || isNaN(bytes)) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val < 10 ? val.toFixed(2) : val.toFixed(1)} ${units[i]}`;
}

export function formatPercentDelta(compressed: number, original: number): string {
  if (original <= 0) return "";
  const ratio = (compressed - original) / original;
  const pct = Math.abs(ratio) * 100;
  const formattedPct = pct < 10 ? pct.toFixed(1) : Math.round(pct).toString();
  if (compressed < original) {
    return `${formattedPct}% smaller`;
  } else if (compressed > original) {
    return `${formattedPct}% larger`;
  } else {
    return "same size";
  }
}

export type AppMode = "idle" | "processing" | "reader";

export interface DiagnosticsReport {
  status: "stalled" | "error";
  timestamp: string;
  stage: string;
  current: number;
  total: number;
  stalledDurationSeconds?: number;
  codec: string;
  codecId: CodecFamily;
  quality: string;
  hardwareAcceleration: string;
  imageCount: number;
  totalOriginalSize: number | null;
  userAgent: string;
  errorMessage?: string;
  downscaleInfo?: string;
  analysis: string;
  suggestions: string[];
}

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

  // Watchdog stall detection & diagnostic report
  readonly isStalled = signal<boolean>(false);
  readonly stallDuration = signal<number>(0);
  readonly stallReport = signal<DiagnosticsReport | null>(null);
  readonly showReportModal = signal<boolean>(false);
  readonly copyFeedback = signal<boolean>(false);
  readonly downscaleNotice = signal<{
    originalW: number;
    originalH: number;
    targetW: number;
    targetH: number;
    reason: string;
  } | null>(null);

  private stageStartTime = 0;
  private lastStageName = "";
  private abortController: AbortController | null = null;
  private watchdogTimer: any = null;
  private lastProgressTimestamp = 0;
  private currentFiles: ImageFileInput[] = [];

  updateProgress(stage: string, current: number, total: number): void {
    const now = performance.now();
    this.lastProgressTimestamp = Date.now();
    if (this.isStalled.value) {
      this.isStalled.value = false;
    }

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
  readonly maxResolution = signal<MaxResolution>("auto");

  // Exportable blob
  private lastExportBlob: Blob | null = null;

  // Reader state
  readonly decodedAlbum = signal<DecodedAlbum | null>(null);
  readonly currentFrame = signal<number>(0);
  readonly isPlaying = signal<boolean>(false);
  readonly isZipping = signal<boolean>(false);

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
  }

  /** Starts the stall watchdog timer during active encoding. */
  private startWatchdog(files: ImageFileInput[], options: EncodeOptions): void {
    this.stopWatchdog();
    this.lastProgressTimestamp = Date.now();
    this.isStalled.value = false;
    this.stallDuration.value = 0;

    this.watchdogTimer = setInterval(() => {
      if (this.mode.value !== "processing") {
        this.stopWatchdog();
        return;
      }

      const stalledMs = Date.now() - this.lastProgressTimestamp;
      const stalledSec = Math.floor(stalledMs / 1000);
      this.stallDuration.value = stalledSec;

      if (stalledSec >= 7) {
        this.isStalled.value = true;
        this.stallReport.value = this.generateReport("stalled", files, options, stalledSec);
      } else if (stalledSec < 7 && this.isStalled.value) {
        this.isStalled.value = false;
      }
    }, 1000);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  /** Constructs a diagnostic report containing detailed metrics and troubleshooting steps. */
  private generateReport(
    status: "stalled" | "error",
    files: ImageFileInput[],
    options: EncodeOptions,
    stalledSec?: number,
    errorMsg?: string,
  ): DiagnosticsReport {
    const codecInfo = this.availableCodecs.value.find((c) => c.id === options.codec);
    const codecName = codecInfo?.name ?? options.codec?.toUpperCase() ?? "Unknown";
    const hwPref = codecInfo?.hasHardwareAcceleration
      ? "GPU Hardware Accelerated (prefer-hardware)"
      : "Software / CPU (no-preference)";

    const isStalledAtFlush = this.progressStage.value.toLowerCase().includes("finaliz");
    const isStalledAtFrames = this.progressStage.value.toLowerCase().includes("frame");

    let analysis = "";
    const suggestions: string[] = [];

    if (status === "stalled") {
      if (isStalledAtFlush) {
        analysis =
          "The video encoder stalled while flushing final frames to the WebM muxer. This typically happens when the GPU driver fails to emit the end-of-stream acknowledgment.";
        suggestions.push("Switch to VP9 codec, which provides broader GPU hardware driver stability.");
        suggestions.push("Choose 'High Quality' or 'Balanced' to reduce memory pressure.");
      } else if (isStalledAtFrames) {
        analysis = `The encoder stalled at item ${this.progressCurrent.value} of ${this.progressTotal.value}. WebCodecs internal backpressure queue is waiting for the GPU driver to release buffers, indicating potential driver hang or memory starvation.`;
        suggestions.push("Switch to VP9 or VP8 for better compatibility with your device's GPU driver.");
        suggestions.push("Reduce the batch size or select 'Balanced' quality.");
      } else {
        analysis = "The encoding pipeline has not emitted any progress events for over 7 seconds.";
        suggestions.push("Cancel and retry with a different codec (e.g. VP9).");
      }
    } else {
      analysis = `Encoding terminated with an error: ${errorMsg || "Unknown error"}. This usually indicates unsupported resolution, codec rejection by the GPU driver, or out-of-memory.`;
      suggestions.push("Switch codec to VP9 or VP8.");
      suggestions.push("Lower encoding quality to High or Balanced.");
    }

    return {
      status,
      timestamp: new Date().toISOString(),
      stage: this.progressStage.value || "Encoding",
      current: this.progressCurrent.value,
      total: this.progressTotal.value,
      stalledDurationSeconds: stalledSec,
      codec: `${codecName} (${codecInfo?.matchedWebCodecsString || options.codec})`,
      codecId: options.codec || "av1",
      quality: options.quality,
      hardwareAcceleration: hwPref,
      imageCount: files.length,
      totalOriginalSize: this.originalSize.value,
      userAgent: navigator.userAgent,
      errorMessage: errorMsg,
      analysis,
      suggestions,
    };
  }

  /** Copies formatted diagnostic report to the user's clipboard. */
  async copyReportToClipboard(): Promise<void> {
    const report = this.stallReport.value;
    if (!report) return;

    const lines = [
      "=== av1pack Diagnostics Report ===",
      `Status: ${report.status.toUpperCase()}`,
      `Timestamp: ${report.timestamp}`,
      `Stage: ${report.stage}`,
      `Progress: ${report.current} / ${report.total} items`,
      report.stalledDurationSeconds ? `Stalled Duration: ${report.stalledDurationSeconds}s without progress` : "",
      `Codec: ${report.codec}`,
      `Hardware Acceleration: ${report.hardwareAcceleration}`,
      `Quality: ${report.quality}`,
      `Album Images: ${report.imageCount}`,
      `Total Original Size: ${report.totalOriginalSize ? formatBytes(report.totalOriginalSize) : "N/A"}`,
      `User Agent: ${report.userAgent}`,
      report.errorMessage ? `Error Message: ${report.errorMessage}` : "",
      "",
      "--- Analysis ---",
      report.analysis,
      "",
      "--- Suggested Actions ---",
      ...report.suggestions.map((s) => `• ${s}`),
      "==================================",
    ].filter(Boolean);

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      this.copyFeedback.value = true;
      setTimeout(() => (this.copyFeedback.value = false), 2000);
    } catch (err) {
      console.warn("Failed to copy report to clipboard:", err);
    }
  }

  /** Cancels the ongoing encoding pipeline immediately. */
  cancelEncoding(): void {
    if (this.abortController) {
      this.abortController.abort("User cancelled encoding");
      this.abortController = null;
    }
    this.stopWatchdog();
    this.isStalled.value = false;
    this.stallDuration.value = 0;
    this.statusMessage.value = "Encoding cancelled";
    this.mode.value = "idle";
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

  /** Loads the built-in Wikipedia example dataset and packs it. */
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

  /** Encodes image files to video in a Web Worker with watchdog & cancellation protection. */
  private async processImages(files: ImageFileInput[]): Promise<void> {
    this.currentFiles = files;
    const totalOriginalSize = files.reduce((acc, f) => acc + (f.file?.size || 0), 0);
    this.originalSize.value = totalOriginalSize > 0 ? totalOriginalSize : null;

    this.mode.value = "processing";
    this.progressStage.value = "Preparing images";
    this.progressCurrent.value = 0;
    this.progressTotal.value = files.length;
    this.isStalled.value = false;
    this.stallReport.value = null;

    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    const options: EncodeOptions = {
      fps: 30,
      quality: this.quality.value,
      codec: this.selectedCodec.value,
      maxResolution: this.maxResolution.value,
    };

    this.startWatchdog(files, options);

    try {
      const result = await encodeAlbum(
        files,
        options,
        (stage, cur, tot) => {
          this.updateProgress(stage, cur, tot);
        },
        signal,
      );

      this.stopWatchdog();
      this.lastExportBlob = result.exportBlob;
      this.compressedSize.value = result.exportBlob.size;

      if (result.downscaleReport) {
        this.downscaleNotice.value = {
          originalW: result.downscaleReport.originalWidth,
          originalH: result.downscaleReport.originalHeight,
          targetW: result.downscaleReport.scaledWidth,
          targetH: result.downscaleReport.scaledHeight,
          reason: result.downscaleReport.reason,
        };
      } else {
        this.downscaleNotice.value = null;
      }

      // Immediately load clean WebM stream into reader
      this.progressStage.value = "Opening in frame reader";
      const album = await loadPackedVideo(result.cleanBlob, result.metadata);
      this.setDecodedAlbum(album);
    } catch (err: any) {
      this.stopWatchdog();
      if (err.name === "AbortError" || signal.aborted) {
        this.mode.value = "idle";
        return;
      }
      this.mode.value = "idle";
      this.stallReport.value = this.generateReport("error", files, options, 0, err?.message || String(err));
      this.errorMessage.value = `Encoding failed: ${err?.message || err}`;
      console.error("Encoding error:", err);
    } finally {
      this.stopWatchdog();
      this.abortController = null;
    }
  }

  /** Retries encoding the current album with a different codec (e.g. fallback from AV1 to VP9). */
  async retryWithCodec(codec: CodecFamily): Promise<void> {
    this.showReportModal.value = false;
    this.selectedCodec.value = codec;
    if (this.currentFiles.length > 0) {
      await this.processImages(this.currentFiles);
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
    if (this.originalSize.value === null && album.metadata) {
      let sum = 0;
      let count = 0;
      for (const item of Object.values(album.metadata)) {
        if (typeof item.orig_size === "number" && item.orig_size > 0) {
          sum += item.orig_size;
          count++;
        }
      }
      if (count > 0) {
        this.originalSize.value = sum;
      }
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
      this.currentFrame.value = 0;
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

  /** Extracts all unpadded frames and builds a ZIP archive. */
  async downloadZip(): Promise<void> {
    const album = this.decodedAlbum.value;
    if (!album) return;

    this.isZipping.value = true;
    const prevStage = this.progressStage.value;

    try {
      const extractedFiles = await album.extractAllFrames((stage, cur, tot) => {
        this.updateProgress(stage, cur, tot);
      });

      this.progressStage.value = "Creating ZIP archive...";
      this.progressEta.value = "";
      await new Promise((r) => setTimeout(r, 10));

      const zipBytes = await createZip(extractedFiles);
      const zipBlob = new Blob([zipBytes.buffer as ArrayBuffer], { type: "application/zip" });

      await saveFile(
        zipBlob,
        "album_unpacked.zip",
        "ZIP Archive",
        "application/zip",
        "zip",
      );
    } catch (err: any) {
      this.errorMessage.value = `Failed to create ZIP: ${err?.message || err}`;
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

    try {
      const blobToExport = this.lastExportBlob ?? album.cleanBlob;

      await saveFile(
        blobToExport,
        "album_packed.webm",
        "Packed Video",
        "video/webm",
        "webm",
      );
    } catch (err: any) {
      this.errorMessage.value = `Failed to export video: ${err?.message || err}`;
    }
  }

  reset(): void {
    this.cancelEncoding();
    this.stopSlideshow();
    if (this.decodedAlbum.value) {
      this.decodedAlbum.value.cleanup();
      this.decodedAlbum.value = null;
    }
    this.currentFiles = [];
    this.lastExportBlob = null;
    this.compressedSize.value = null;
    this.originalSize.value = null;
    this.downscaleNotice.value = null;
    this.currentFrame.value = 0;
    this.mode.value = "idle";
    this.errorMessage.value = null;
    this.progressEta.value = "";
    this.stageStartTime = 0;
    this.lastStageName = "";
    this.showReportModal.value = false;
    this.stallReport.value = null;
  }
}

export const app = new AppController();
