<img width="256" height="256" alt="image" src="https://github.com/user-attachments/assets/f73fbca0-598d-4440-99de-32eff9117443" />


# av1pack: Visually lossless image album compression w/ H264
Fundamentally what this project does, it "packs" your album (folder) of images into a h264 video for better compression applied over every image's similar features, This allows for better compression than simply archiving the images w/ zip or 7z, And the resulting H264 video can even be _eventually_ even used as an instant slideshow

## Working
![](./av1pack%20Architecture%20Diagram.png)

## Features
- NVENC HW accelerated encoding support (via ffmpeg)
- Supporting metadata is also encoded and not lost during packing
- **WIP** Support for images containing alpha
- **WIP** EXIF & other metadata also stored with images

## Graphs
Not a great benchmark but compressing the `gov_small` dataset, makes it about 50% smaller

All related files are found [here](https://mega.nz/folder/ByxhSCZQ#TCxSIJBMlo5Y_0ijU2g8qg)

![](./chart.png)

> **Warning**: The output file size can vary a lot depending on the images and the settings used so its not always better and can sometimes even be worse compared to zip archive, Also encoder settings work differently from encoder to encoder so best consult the ffmpeg docs as you go

## Web App (In-Browser Packing & Frame Reader)
av1pack runs completely client-side in the browser powered by **Preact**, **Zig WebAssembly**, the **WebCodecs VideoEncoder API**, and the **File System Access API**. Everything executes locally on your GPU/CPU with 0 bytes uploaded to any server.

### Features
- **Large Multi-Functional Drop Zone**: Drag & drop an entire folder of photos or an existing packed video (`.webm`).
- **File System Access API**: Direct local directory selection (`showDirectoryPicker`) and native save dialogs.
- **Hardware-Accelerated VideoEncoder API**: Native AV1 (`av01`) video encoding directly on your GPU without heavy WebAssembly video codecs.
- **Zig WebAssembly Core (`wasm/`)**: Ultra-fast image padding/cropping and standard PKZIP archive generation using Zig's `std.zip`.
- **Interactive Frame Reader**: Scrub frame-by-frame through the album, view original filenames/dimensions, autoplay slideshow, and download all original unpadded frames together in one click as a `.zip` archive.

### Running the Web App Locally
```bash
cd web
bun install
bun run dev      # Builds wasm with zig and starts Vite dev server
```
To create a production build:
```bash
bun run build    # Outputs standalone static bundle into web/dist
```

## TODO
- [x] Web App with Preact & File System Access API
- [x] Zig WASM core with `std.zip`
- [x] Interactive frame reader & ZIP export
- [x] WebCodecs VideoEncoder hardware acceleration
- Modifiable video parameters for more _slideshow_ ahh output
- Rename since I didn't end up actually using AV1
- ! Normalize Colorspace
- ! test against larger & more varied dataset
- ! Find a sweetspot of compression settings (ideally more towards lossless)
- ! more comparison charts

## Acknowledgements
- This project heavily relies on the incredible capabilities of [FFmpeg](https://ffmpeg.org/) for video encoding and decoding.
- Special thanks to the [Pillow (PIL)](https://python-pillow.org/) library for providing powerful image processing tools.
