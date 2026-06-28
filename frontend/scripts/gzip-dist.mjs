import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

const dist = new URL("../dist/", import.meta.url);
const gzipped = new URL("../dist_gzipped/", import.meta.url);
await rm(gzipped, { recursive: true, force: true });
await gzipDirectory(dist, gzipped);

async function gzipDirectory(source, destination) {
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const sourcePath = new URL(entry.name, source);
    if (entry.isDirectory()) {
      await gzipDirectory(
        new URL(`${entry.name}/`, source),
        new URL(`${entry.name}/`, destination),
      );
    } else if (entry.isFile()) {
      const destinationPath = new URL(`${entry.name}.gz`, destination);
      await writeFile(destinationPath, gzipSync(await readFile(sourcePath), { level: 9 }));
    }
  }));
}
