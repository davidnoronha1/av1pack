import { gzipSync, gunzipSync } from "fflate";

/**
 * Compresses data using gzip directly via fflate (in-memory Uint8Array, no Response streams).
 */
export async function gzipCompress(data: Uint8Array): Promise<Uint8Array> {
  return gzipSync(data, { level: 6 });
}

/**
 * Decompresses gzip data directly via fflate (in-memory Uint8Array, no Response streams).
 */
export async function gzipDecompress(data: Uint8Array): Promise<Uint8Array> {
  return gunzipSync(data);
}
