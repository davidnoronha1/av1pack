// Browser-native gzip compression & decompression using CompressionStream/DecompressionStream.

export async function gzipCompress(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(data).body!.pipeThrough(new CompressionStream("gzip"));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

export async function gzipDecompress(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(data).body!.pipeThrough(new DecompressionStream("gzip"));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}
