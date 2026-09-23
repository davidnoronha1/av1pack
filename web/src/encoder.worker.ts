import { executeEncodePipeline } from "./encoder-core";

self.onmessage = async (e: MessageEvent) => {
  const { id, type, files, options } = e.data;
  if (type === "encode") {
    try {
      const result = await executeEncodePipeline(
        files,
        options,
        (stage, current, total) => {
          self.postMessage({ id, type: "progress", stage, current, total });
        },
      );
      self.postMessage({ id, type: "success", result });
    } catch (err: any) {
      self.postMessage({ id, type: "error", error: err?.message || String(err) });
    }
  }
};
