export type CodecFamily = "av1" | "vp9" | "vp8";

export function isMobileOrTablet(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const isTouch = typeof navigator.maxTouchPoints === "number" && navigator.maxTouchPoints > 1;
  const isMobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  const isIPadOS = isTouch && /Macintosh/i.test(ua);
  return isMobileUA || isIPadOS;
}

export interface DeviceHardwareProfile {
  isMobile: boolean;
  deviceMemoryGb: number;
  cores: number;
  maxCacheMemoryBytes: number;
  maxBitrateLossless: number;
  maxBitrateHigh: number;
  maxBitrateBalanced: number;
}

export function getDeviceHardwareProfile(): DeviceHardwareProfile {
  const isMobile = isMobileOrTablet();
  let mem = 8;
  if (typeof navigator !== "undefined" && typeof (navigator as any).deviceMemory === "number") {
    mem = (navigator as any).deviceMemory;
  } else if (isMobile) {
    mem = 4;
  }

  const cores =
    typeof navigator !== "undefined" && typeof navigator.hardwareConcurrency === "number"
      ? navigator.hardwareConcurrency
      : 4;

  let maxCacheMemoryBytes: number;
  let maxBitrateLossless: number;
  let maxBitrateHigh: number;
  let maxBitrateBalanced: number;

  if (mem >= 8 && !isMobile) {
    // Powerful workstation / desktop
    maxCacheMemoryBytes = 160 * 1024 * 1024; // 160 MB cache
    maxBitrateLossless = 80_000_000;          // 80 Mbps
    maxBitrateHigh = 45_000_000;              // 45 Mbps
    maxBitrateBalanced = 25_000_000;          // 25 Mbps
  } else if (mem >= 6 || (!isMobile && mem >= 4)) {
    // Modern capable laptop / premium tablet (iPad Pro, 6GB+ Android tablet)
    maxCacheMemoryBytes = 80 * 1024 * 1024;  // 80 MB cache
    maxBitrateLossless = 50_000_000;          // 50 Mbps
    maxBitrateHigh = 30_000_000;              // 30 Mbps
    maxBitrateBalanced = 18_000_000;          // 18 Mbps
  } else {
    // Memory-limited mobile / budget tablet (<= 4GB RAM)
    maxCacheMemoryBytes = 36 * 1024 * 1024;  // 36 MB cache
    maxBitrateLossless = 35_000_000;          // 35 Mbps
    maxBitrateHigh = 20_000_000;              // 20 Mbps
    maxBitrateBalanced = 12_000_000;          // 12 Mbps
  }

  return {
    isMobile,
    deviceMemoryGb: mem,
    cores,
    maxCacheMemoryBytes,
    maxBitrateLossless,
    maxBitrateHigh,
    maxBitrateBalanced,
  };
}

/**
 * Actively probes whether the device hardware GPU encoder supports a given resolution and bitrate.
 */
export async function probeHardwareResolutionSupport(
  family: CodecFamily,
  width: number,
  height: number,
  bitrate: number,
  fps = 30,
): Promise<{ supported: boolean; hardware: boolean; codecString?: string }> {
  if (typeof VideoEncoder === "undefined") {
    return { supported: false, hardware: false };
  }

  const def = CODEC_DEFINITIONS[family] || CODEC_DEFINITIONS.av1;

  // 1. First probe prefer-hardware
  for (const codec of def.candidates) {
    const config: VideoEncoderConfig = {
      codec,
      width,
      height,
      bitrate,
      framerate: fps,
      bitrateMode: "variable",
      hardwareAcceleration: "prefer-hardware",
    };
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (support.supported && support.config?.hardwareAcceleration === "prefer-hardware") {
        return { supported: true, hardware: true, codecString: codec };
      }
    } catch {
      // Continue probe
    }
  }

  // 2. Fallback probe: check no-preference (may use software)
  for (const codec of def.candidates) {
    const config: VideoEncoderConfig = {
      codec,
      width,
      height,
      bitrate,
      framerate: fps,
      bitrateMode: "variable",
      hardwareAcceleration: "no-preference",
    };
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (support.supported) {
        return { supported: true, hardware: false, codecString: codec };
      }
    } catch {
      // Continue probe
    }
  }

  return { supported: false, hardware: false };
}

export interface AvailableCodec {
  id: CodecFamily;
  name: string;
  containerCodec: "V_AV1" | "V_VP9" | "V_VP8";
  matchedWebCodecsString: string;
  hasHardwareAcceleration: boolean;
  hardwareAccelerationPreference: HardwareAcceleration;
  description: string;
}

export const CODEC_DEFINITIONS: Record<
  CodecFamily,
  {
    name: string;
    containerCodec: "V_AV1" | "V_VP9" | "V_VP8";
    candidates: string[];
    description: string;
  }
> = {
  av1: {
    name: "AV1",
    containerCodec: "V_AV1",
    candidates: [
      "av01.0.08M.10",
      "av01.0.04M.08",
      "av01.0.05M.08",
      "av01.0.00M.08",
    ],
    description: "Next-gen open codec with highest compression density.",
  },
  vp9: {
    name: "VP9",
    containerCodec: "V_VP9",
    candidates: [
      "vp09.00.10.08",
      "vp09.00.41.08",
      "vp09.02.10.10",
    ],
    description: "Widely supported high-efficiency codec with widespread GPU hardware encode on laptops.",
  },
  vp8: {
    name: "VP8",
    containerCodec: "V_VP8",
    candidates: ["vp8"],
    description: "Universal compatibility baseline codec.",
  },
};

/**
 * Detects which WebM video codecs are supported by the browser's WebCodecs engine
 * and checks whether dedicated hardware (GPU) acceleration is available.
 */
export async function detectAvailableCodecs(): Promise<AvailableCodec[]> {
  if (typeof VideoEncoder === "undefined") {
    return [
      {
        id: "av1",
        name: "AV1",
        containerCodec: "V_AV1",
        matchedWebCodecsString: "av01.0.04M.08",
        hasHardwareAcceleration: false,
        hardwareAccelerationPreference: "no-preference",
        description: CODEC_DEFINITIONS.av1.description,
      },
    ];
  }

  const results: AvailableCodec[] = [];
  const families: CodecFamily[] = ["av1", "vp9", "vp8"];

  for (const family of families) {
    const def = CODEC_DEFINITIONS[family];
    let matchedCodec: string | null = null;
    let hasHw = false;
    let chosenHwPref: HardwareAcceleration = "no-preference";

    // 1. Check for hardware acceleration support
    for (const codec of def.candidates) {
      const config: VideoEncoderConfig = {
        codec,
        width: 1920,
        height: 1080,
        bitrate: 10_000_000,
        framerate: 30,
        bitrateMode: "variable",
        hardwareAcceleration: "prefer-hardware",
      };

      try {
        const support = await VideoEncoder.isConfigSupported(config);
        if (support.supported) {
          matchedCodec = codec;
          if (support.config?.hardwareAcceleration === "prefer-hardware") {
            hasHw = true;
            chosenHwPref = "prefer-hardware";
            break;
          }
        }
      } catch {
        // Continue searching
      }
    }

    // 2. If no hardware support found, check software / no-preference
    if (!matchedCodec) {
      for (const codec of def.candidates) {
        const config: VideoEncoderConfig = {
          codec,
          width: 1920,
          height: 1080,
          bitrate: 10_000_000,
          framerate: 30,
          bitrateMode: "variable",
          hardwareAcceleration: "no-preference",
        };

        try {
          const support = await VideoEncoder.isConfigSupported(config);
          if (support.supported) {
            matchedCodec = codec;
            chosenHwPref = "no-preference";
            break;
          }
        } catch {
          // Continue searching
        }
      }
    }

    if (matchedCodec) {
      results.push({
        id: family,
        name: def.name,
        containerCodec: def.containerCodec,
        matchedWebCodecsString: matchedCodec,
        hasHardwareAcceleration: hasHw,
        hardwareAccelerationPreference: chosenHwPref,
        description: def.description,
      });
    }
  }

  // Fallback if probe returned empty
  if (results.length === 0) {
    results.push({
      id: "av1",
      name: "AV1",
      containerCodec: "V_AV1",
      matchedWebCodecsString: "av01.0.04M.08",
      hasHardwareAcceleration: false,
      hardwareAccelerationPreference: "no-preference",
      description: CODEC_DEFINITIONS.av1.description,
    });
  }

  return results;
}

/**
 * Chooses the best default codec:
 * 1. Prefers AV1 if hardware accelerated.
 * 2. If AV1 lacks hardware acceleration, chooses any other codec (like VP9) that has hardware acceleration.
 * 3. Falls back to AV1 (or first supported).
 */
export function pickDefaultCodec(codecs: AvailableCodec[]): CodecFamily {
  const av1 = codecs.find((c) => c.id === "av1");
  if (av1?.hasHardwareAcceleration) return "av1";

  const anyHw = codecs.find((c) => c.hasHardwareAcceleration);
  if (anyHw) return anyHw.id;

  if (av1) return "av1";
  return codecs[0]?.id ?? "av1";
}
