<p align="center">
  <img width="200" height="200" alt="av1pack logo" src="https://github.com/user-attachments/assets/f73fbca0-598d-4440-99de-32eff9117443" />
</p>

<h1 align="center">av1pack</h1>

<p align="center">
  <strong>Visually lossless image album compression using next-gen video codecs directly in your browser.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Privacy-100%25%20Client--Side-brightgreen?style=flat-square" alt="Privacy" />
  <img src="https://img.shields.io/badge/Codecs-AV1%20%7C%20VP9%20%7C%20VP8-blue?style=flat-square" alt="Codecs" />
  <img src="https://img.shields.io/badge/Powered%20By-WebCodecs%20%2B%20Preact-orange?style=flat-square" alt="Stack" />
  <img src="https://img.shields.io/badge/License-MIT-purple?style=flat-square" alt="License" />
</p>

---

## Overview

**av1pack** compresses an entire photo album into a single high-efficiency video container (`.webm`). 

Traditional archivers (ZIP, 7z) compress images independently as generic byte streams. However, photos in an album frequently share the same lighting, color palette, sensor noise, and scene backgrounds. By sequencing images as video frames, **av1pack** takes advantage of modern inter-frame and spatial prediction in video codecs (AV1, VP9, VP8) to achieve **up to 50% better compression** than generic archives, while maintaining visual losslessness and doubling as an instant slideshow.

All original image filenames, dimensions, and alpha channels are preserved in a lightweight binary trailer at the end of the video file.

---

## Internal Architecture & Diagrams

av1pack is 100% client-side. The diagrams below illustrate the encoding flow, dual-layer container layout, and decoding/scrubbing pipeline.

### 1. Encoding Pipeline

```mermaid
flowchart TD
    subgraph Ingestion ["1. Album Ingestion & Fast Header Sniffing"]
        A["Folder / Batch of Images"] --> B["Header Sniffing<br/><code>fastGetImageDimensions</code><br/>(Dimensions & Alpha from PNG/WebP/JPEG headers)"]
        B --> C["Compute Maximum Bounding Box<br/><code>(bboxWidth × bboxHeight)</code>"]
    end

    subgraph Core ["2. Shared Encoding Engine (Worker & Main Thread)"]
        C --> D["Canvas Frame Composition<br/>(GPU-accelerated, zero CPU readback)"]
        D --> E["GPU <code>VideoFrame</code> Creation"]
        E --> F["WebCodecs <code>VideoEncoder</code><br/>(Hardware-Accelerated AV1 / VP9 / VP8)"]
        B --> G["WebVTT Subtitle Encoder<br/>(Timed JSON Metadata Cues)"]
        F --> H["WebM Muxer (Video Track)"]
        G --> H["WebM Muxer (Subtitle Track)"]
    end

    subgraph Packaging ["3. Dual-Layer Container Packaging"]
        H --> I["WebM Container with In-Band WebVTT Track"]
        J["Album Metadata (JSON)"] --> K["Gzip Compression"]
        I --> L["Packed <code>.webm</code> File"]
        K --> L
        M["Trailer Footer<br/><code>'AV1PACK\0' + 4-byte Length</code>"] --> L
    end
```

### 2. Dual-Layer Container Layout

To guarantee that metadata survives FFmpeg remuxing (`ffmpeg -c copy`), social media video uploaders, and video trimmers, metadata is embedded **directly inside the WebM container** as a WebVTT track, with a trailer appended for instant reading:

```
┌─────────────────────────────────────────────────────────────┐
│                    WebM Container (EBML)                    │
│                                                             │
│  Track 1: Video Track (AV1 / VP9 / VP8)                     │
│  • Padded frames: (bboxWidth × bboxHeight)                  │
│                                                             │
│  Track 2: WebVTT Timed Metadata Track (V_TEXT/WEBVTT)       │
│  • Cue 1: [00:00.000 --> 00:00.033] {"filename", "w", "h"} │
│  • Cue 2: [00:00.033 --> 00:00.066] {"filename", "w", "h"} │
│  • Survives ffmpeg -c copy -map 0 & video processing        │
├─────────────────────────────────────────────────────────────┤
│                 Gzip-Compressed Metadata JSON               │
│  • Instant fallback trailer for zero-latency reading        │
├─────────────────────────────────────────────────────────────┤
│                        Magic Bytes                          │
│  • 8 Bytes ASCII: "AV1PACK\0" (0x41 56 31 50 41 43 4B 00)   │
├─────────────────────────────────────────────────────────────┤
│                    Metadata Length Footer                   │
│  • 4 Bytes: Uint32 Little-Endian (Byte length of Gzip data) │
└─────────────────────────────────────────────────────────────┘
```

### 3. Decoding & Extraction Pipeline

```mermaid
flowchart LR
    A["Packed <code>.webm</code> File"] --> B["Metadata Extractor"]
    B -->|"Path A: Trailer Present"| C["Instant Gzip Decompress"]
    B -->|"Path B: Trailer Stripped"| D["In-Container WebVTT Parser"]
    C --> E["Album Metadata<br/>(Filenames, Dims, Alpha)"]
    D --> E

    A --> F["HTML5 <code>&lt;video&gt;</code> Engine"]
    F --> G["Seek Timestamp"]
    E --> H["Direct GPU Crop<br/><code>createImageBitmap(video, 0, 0, w, h)</code>"]
    G --> H
    H --> I["Target Canvas (Direct GPU Blit)"]
    H --> J["30-Frame LRU Cache<br/>(GPU ImageBitmaps, 60 FPS)"]
    H --> K["PKZIP Exporter<br/>(Powered by <code>fflate</code>)"]
```

---

## Key Features

- **100% Client-Side & Private**: Runs entirely in your browser sandbox using WebCodecs and the File System Access API. Zero bytes are uploaded to any server.
- **In-Container WebVTT Metadata**: Stores frame metadata directly inside the container as a WebVTT track so it survives video remuxers (`ffmpeg -c copy -map 0`), social media uploads, and video trimming.
- **Hardware-Accelerated Codecs**: Automatically detects GPU hardware encoding for **AV1**, **VP9**, and **VP8**.
- **Unified Engine**: Common encoding engine shared between background Web Workers and the main thread fallback.
- **Zero-Copy Frame Pipeline**:
  - *Encoding*: Uniform-sized images pass directly from `ImageBitmap` to `VideoFrame` without canvas blitting.
  - *Decoding*: Frames crop directly on the GPU texture via `createImageBitmap(video, 0, 0, w, h)`, completely avoiding intermediate canvases and PCIe CPU readbacks (`getImageData`).
- **Zero-CPU-Readback Alpha Detection**: Inspects image headers (PNG `IHDR`, WebP `VP8X`, GIF `GCE`, JPEG) directly without expensive canvas pixel loops.
- **Interactive Frame Reader**:
  - 60 FPS stutter-free scrubbing powered by an internal LRU frame cache.
  - Automatic cropping back to each image's native resolution.
  - Built-in slideshow viewer and photo metadata inspector.
- **High-Performance ZIP Extraction**: Generates standard PKZIP archives in-memory using the battle-tested `fflate` library.
- **Modern File System Access**: Drag & drop entire directories or use native operating system folder pickers and save dialogs.

---

## Compression Benchmark

Testing against the `gov_small` dataset shows **av1pack** outperforming maximum ZIP compression:

<p align="center">
  <img src="./chart.png" alt="Compression Benchmark Chart" width="500" />
</p>

| Format | Size | Reduction vs Original |
| :--- | :--- | :--- |
| **Original Photos (PNG / JPEG)** | 10,197 KB | Baseline |
| **Standard Archive (`zip -9`)** | 9,800 KB | ~3.9% |
| **av1pack (Video Container)** | **5,412 KB** | **~46.9%** |

> [!NOTE]
> Benchmark test dataset files are available on [MEGA](https://mega.nz/folder/ByxhSCZQ#TCxSIJBMlo5Y_0ijU2g8qg). Output size and compression ratio depend on image similarity and chosen encoder quality.

---

## Running Locally

### Prerequisites
- [Bun](https://bun.sh/) (or Node.js 18+)
- A modern Chromium-based browser (Chrome, Edge, Brave) for full WebCodecs and File System Access API support.

### Setup & Development

```bash
# Clone the repository
git clone https://github.com/davidnoronha1/av1pack.git
cd av1pack/web

# Install dependencies
bun install

# Start local Vite development server
bun run dev
```

### Production Build & Deploy

```bash
# Build production bundle (outputs to web/dist)
bun run build

# Deploy to Cloudflare Workers (optional)
bun run deploy
```

---

## License

This project is licensed under the [MIT License](./LICENSE).
