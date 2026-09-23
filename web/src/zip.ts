import { zip, type Zippable } from "fflate";

export interface ZipEntryInput {
  name: string;
  data: Uint8Array;
}

/**
 * Builds a standard PKZIP archive in memory using the high-performance fflate library.
 */
export async function createZip(files: ZipEntryInput[]): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const archive: Zippable = {};
    for (const file of files) {
      archive[file.name] = file.data;
    }
    zip(archive, { level: 6 }, (err, data) => {
      if (err) {
        reject(err);
      } else {
        resolve(data);
      }
    });
  });
}
