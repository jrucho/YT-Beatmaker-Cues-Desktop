import { existsSync } from "node:fs";
import { mkdir, readFile, rename, open, copyFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import type { LibraryStorage } from "./library.js";

/** The library as data/library.json, replaced atomically (write a temp file, then rename over). */
export function fileStorage(dir = config.dataDir): LibraryStorage {
  const file = path.join(dir, "library.json");
  const valid = (text: string) => { const value = JSON.parse(text); return Array.isArray(value.favorites) && Array.isArray(value.playlists) && Array.isArray(value.history); };
  return {
    read: async () => {
      let damaged = false;
      for (const candidate of [file, `${file}.tmp`, `${file}.backup`]) {
        if (!existsSync(candidate)) continue;
        const text = await readFile(candidate, "utf8");
        try { if (valid(text)) return text; } catch {}
        damaged = true;
      }
      if (damaged) throw new Error("Library data is damaged; original files have been retained for recovery");
      return null;
    },
    write: async (json) => {
      if (!valid(json)) throw new Error("Invalid library data");
      await mkdir(dir, { recursive: true });
      const tmp = `${file}.tmp`;
      if (existsSync(file)) {
        const previous = await readFile(file, "utf8");
        let healthy = false; try { healthy = valid(previous); } catch {}
        await copyFile(file, healthy ? `${file}.backup` : `${file}.corrupt-${Date.now()}`);
      }
      const output = await open(tmp, "w");
      try { await output.writeFile(json, "utf8"); await output.sync(); } finally { await output.close(); }
      await rename(tmp, file);
    },
  };
}
