import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import type { LibraryStorage } from "../../../server/src/library";

const FILE = "library.json";
const TMP = "library.tmp.json";
const BACKUP = "library.backup.json";
const where = { directory: Directory.Data, encoding: Encoding.UTF8 } as const;

async function readText(path: string): Promise<string | null> {
  try {
    const { data } = await Filesystem.readFile({ path, ...where });
    return typeof data === "string" ? data : await data.text();
  } catch {
    return null;
  }
}

/**
 * The library in the app's private storage. Each save goes to a temp file first and then replaces the real one,
 * so a crash mid-write can't leave a half-written library; if it happens between the two steps, the temp file
 * is the newest complete copy.
 */
export const nativeStorage: LibraryStorage = {
  read: async () => {
    let damaged = false;
    for (const name of [FILE, TMP, BACKUP]) {
      const text = await readText(name);
      if (text == null) continue;
      try { const value = JSON.parse(text); if (Array.isArray(value.favorites) && Array.isArray(value.playlists) && Array.isArray(value.history)) return text; } catch {}
      damaged = true;
    }
    if (damaged) throw new Error("Library data needs recovery; existing files have been retained");
    return null;
  },
  write: async (json) => {
    const previous = await readText(FILE);
    if (previous != null) {
      try {
        const value = JSON.parse(previous);
        if (Array.isArray(value.favorites) && Array.isArray(value.playlists) && Array.isArray(value.history))
          await Filesystem.writeFile({ path: BACKUP, data: previous, ...where });
      } catch { /* preserve damaged primary until the new temporary file is ready */ }
    }
    await Filesystem.writeFile({ path: TMP, data: json, ...where });
    await Filesystem.deleteFile({ path: FILE, directory: Directory.Data }).catch(() => {});
    await Filesystem.rename({ from: TMP, to: FILE, directory: Directory.Data, toDirectory: Directory.Data });
  },
};
