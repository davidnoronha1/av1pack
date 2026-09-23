import { useEffect, useRef } from "preact/hooks";
import { app, formatBytes } from "./controller";

export function App() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Initialize WASM on mount
  useEffect(() => {
    void app.init();
  }, []);

  // Global safety net for unhandled errors and rejections
  useEffect(() => {
    const handleRejection = (e: PromiseRejectionEvent) => {
      console.error("Global unhandled rejection:", e.reason);
      const msg = e.reason?.message || String(e.reason || "Unexpected error occurred");
      app.errorMessage.value = msg;
      if (app.mode.value === "processing") {
        app.mode.value = "idle";
      }
    };

    const handleError = (e: ErrorEvent) => {
      console.error("Global error:", e.error || e.message);
      const msg = e.message || "An unexpected error occurred";
      app.errorMessage.value = msg;
      if (app.mode.value === "processing") {
        app.mode.value = "idle";
      }
    };

    window.addEventListener("unhandledrejection", handleRejection);
    window.addEventListener("error", handleError);
    return () => {
      window.removeEventListener("unhandledrejection", handleRejection);
      window.removeEventListener("error", handleError);
    };
  }, []);

  // Keyboard navigation for reader
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (app.mode.value !== "reader") return;

      if (e.key === "ArrowLeft") {
        e.preventDefault();
        app.prevFrame();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        app.nextFrame();
      } else if (e.key === " ") {
        e.preventDefault();
        app.toggleSlideshow();
      } else if (e.key === "Home") {
        e.preventDefault();
        app.goToFrame(0);
      } else if (e.key === "End") {
        e.preventDefault();
        if (app.decodedAlbum.value) {
          app.goToFrame(app.decodedAlbum.value.totalFrames - 1);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Re-render canvas whenever currentFrame changes in reader mode with error handling
  useEffect(() => {
    const album = app.decodedAlbum.value;
    const canvas = canvasRef.current;
    if (app.mode.value === "reader" && album && canvas) {
      album.renderFrame(app.currentFrame.value, canvas).catch((err) => {
        console.error("Frame rendering error:", err);
        app.errorMessage.value = `Failed to render frame ${app.currentFrame.value + 1}: ${err?.message || err}`;
      });
    }
  }, [app.mode.value, app.currentFrame.value, app.decodedAlbum.value]);

  const album = app.decodedAlbum.value;
  const currentMeta = album?.metadata[app.currentFrame.value.toString()];

  return (
    <div class="container">
      <header>
        <div class="header-brand">
          <img src="/logo.svg" alt="av1pack logo" class="header-logo" width="44" height="44" />
          <div class="header-text">
            <h1>av1pack</h1>
            <p class="subtitle">Visually lossless album video compression & frame reader</p>
          </div>
        </div>
        <a
          href="https://github.com/davidnoronha1/av1pack"
          target="_blank"
          rel="noopener noreferrer"
          class="github-link"
          title="View on GitHub"
          aria-label="View on GitHub"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
          </svg>
        </a>
      </header>

      {app.errorMessage.value && (
        <div class="error-banner">
          <div class="error-content">
            <span class="error-icon">⚠️</span>
            <span>{app.errorMessage.value}</span>
          </div>
          <button
            type="button"
            class="error-dismiss"
            onClick={() => (app.errorMessage.value = null)}
            title="Dismiss error"
            aria-label="Dismiss error"
          >
            ✕
          </button>
        </div>
      )}

      {/* Large Multi-functional Drop Zone */}
      <section
        class={[
          "drop-zone",
          app.isDragOver.value ? "drag-over" : "",
          app.mode.value === "reader" ? "reader-active" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        onDragOver={(e) => {
          e.preventDefault();
          app.isDragOver.value = true;
        }}
        onDragLeave={() => (app.isDragOver.value = false)}
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer) {
            void app.handleDrop(e.dataTransfer);
          }
        }}
      >
        {app.mode.value === "idle" && (
          <>
            <svg class="drop-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
            </svg>
            <h2 class="drop-title">Drag & drop an image album folder here</h2>
            <p class="drop-subtitle">
              Drop an image album folder to pack into an AV1/VP9 video, open a packed <code>.webm</code>, or test with our sample Wikipedia dataset.
            </p>

            <div class="button-group">
              <button type="button" onClick={() => void app.selectFolder()}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                </svg>
                Select Folder
              </button>

              <button type="button" class="secondary" onClick={() => fileInputRef.current?.click()}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
                Open Packed Video
              </button>

              <button type="button" class="example-btn" onClick={() => void app.loadWikipediaExample()}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 2a10 10 0 100 20 10 10 0 000-20zM2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
                </svg>
                Try Wikipedia Example
              </button>
            </div>

            {/* Hidden fallback inputs */}
            <input
              ref={fileInputRef}
              type="file"
              accept=".mkv,.webm,.mp4"
              style={{ display: "none" }}
              onChange={(e) => {
                const file = e.currentTarget.files?.[0];
                if (file) void app.selectPackedFile(file);
                e.currentTarget.value = "";
              }}
            />
            <input
              ref={folderInputRef}
              type="file"
              // @ts-expect-error webkitdirectory
              webkitdirectory=""
              style={{ display: "none" }}
            />

            <div class="settings-bar">
              <label class="codec-label">
                Codec:
                <select
                  value={app.selectedCodec.value}
                  onChange={(e) => (app.selectedCodec.value = e.currentTarget.value as any)}
                >
                  {app.availableCodecs.value.length > 0 ? (
                    app.availableCodecs.value.map((c) => (
                      <option value={c.id}>
                        {c.name} {c.hasHardwareAcceleration ? "⚡ (GPU Accelerated)" : "(CPU)"}
                      </option>
                    ))
                  ) : (
                    <option value="av1">AV1 (WebM)</option>
                  )}
                </select>
                {app.availableCodecs.value.find((c) => c.id === app.selectedCodec.value)?.hasHardwareAcceleration && (
                  <span class="hw-badge" title="Hardware GPU encoding active on this device">
                    ⚡ GPU Accelerated
                  </span>
                )}
              </label>

              <label>
                Quality:
                <select
                  value={app.quality.value}
                  onChange={(e) => (app.quality.value = e.currentTarget.value as any)}
                >
                  <option value="lossless">Visually Lossless (High Bitrate)</option>
                  <option value="high">High Quality</option>
                  <option value="balanced">Balanced</option>
                </select>
              </label>
            </div>
          </>
        )}

        {app.mode.value === "processing" && (
          <div class="progress-card">
            <div class="progress-header">
              <span class="progress-stage">{app.progressStage.value}</span>
              <span class="progress-percent">{app.progressPercent.value}%</span>
            </div>
            <div class="progress-bar-bg">
              <div
                class="progress-bar-fill"
                style={{ width: `${app.progressPercent.value}%` }}
              />
            </div>
            <div class="progress-footer">
              {app.progressTotal.value > 0 ? (
                <span class="progress-count">
                  Item {app.progressCurrent.value} of {app.progressTotal.value}
                </span>
              ) : (
                <span class="progress-count" />
              )}
              {app.progressEta.value && (
                <span class="progress-eta">{app.progressEta.value}</span>
              )}
            </div>
            <div class="progress-actions">
              <button
                type="button"
                class="secondary cancel-btn"
                onClick={() => app.reset()}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {app.mode.value === "reader" && album && (
          <div class="reader-container">
            <div class="reader-header">
              <div class="reader-info">
                <span class="filename-badge" title={currentMeta?.filename}>
                  📄 {currentMeta?.filename || `Frame ${app.currentFrame.value + 1}`}
                </span>
                {currentMeta && (
                  <span class="dimensions-badge">
                    {currentMeta.width} × {currentMeta.height} px
                  </span>
                )}
                {app.compressedSize.value !== null && (
                  <span
                    class="dimensions-badge size-badge"
                    title={
                      app.originalSize.value
                        ? `Original: ${formatBytes(app.originalSize.value)} → Compressed: ${formatBytes(app.compressedSize.value)}`
                        : `Compressed size: ${formatBytes(app.compressedSize.value)}`
                    }
                  >
                    📦 Compressed: <strong>{formatBytes(app.compressedSize.value)}</strong>
                    {app.originalSize.value && app.originalSize.value > app.compressedSize.value && (
                      <span class="savings-tag">
                        {" "}({Math.round((1 - app.compressedSize.value / app.originalSize.value) * 100)}% smaller)
                      </span>
                    )}
                  </span>
                )}
              </div>

              <div class="button-group">
                <button
                  type="button"
                  class="success"
                  disabled={app.isZipping.value}
                  onClick={() => void app.downloadZip()}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
                  </svg>
                  {app.isZipping.value ? "Creating ZIP..." : "Download as ZIP"}
                </button>

                <button type="button" class="secondary" onClick={() => void app.exportVideo()}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
                    <path d="M17 21v-8H7v8M7 3v5h8" />
                  </svg>
                  Export Video {app.compressedSize.value !== null ? `(${formatBytes(app.compressedSize.value)})` : ""}
                </button>

                <button type="button" class="secondary" onClick={() => app.reset()}>
                  Load Another
                </button>
              </div>
            </div>

            {/* Interactive Canvas Viewport */}
            <div class="canvas-viewport">
              <canvas ref={canvasRef} />
            </div>

            {/* Reader Scrubber & Controls */}
            <div class="reader-controls">
              <div class="scrubber-row">
                <input
                  type="range"
                  min="0"
                  max={album.totalFrames - 1}
                  value={app.currentFrame.value}
                  onInput={(e) => app.goToFrame(Number(e.currentTarget.value))}
                />
                <span class="frame-counter">
                  {app.currentFrame.value + 1} / {album.totalFrames}
                </span>
              </div>

              <div class="nav-buttons-row">
                <button type="button" class="secondary" title="First Frame (Home)" onClick={() => app.goToFrame(0)}>
                  ⏮
                </button>
                <button type="button" class="secondary" title="Previous Frame (Left Arrow)" onClick={() => app.prevFrame()}>
                  ◀ Prev
                </button>
                <button
                  type="button"
                  title="Toggle Slideshow (Space)"
                  onClick={() => app.toggleSlideshow()}
                >
                  {app.isPlaying.value ? "⏸ Pause" : "▶ Play"}
                </button>
                <button type="button" class="secondary" title="Next Frame (Right Arrow)" onClick={() => app.nextFrame()}>
                  Next ▶
                </button>
                <button
                  type="button"
                  class="secondary"
                  title="Last Frame (End)"
                  onClick={() => app.goToFrame(album.totalFrames - 1)}
                >
                  ⏭
                </button>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
