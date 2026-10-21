// File managers and installers get a padded, flattened bitmap; the launcher activity keeps its adaptive icon.
import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

for (const density of ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"]) {
  const directory = new URL(`../android/app/src/main/res/mipmap-${density}/`, import.meta.url);
  copyFileSync(fileURLToPath(new URL("ic_launcher.png", directory)), fileURLToPath(new URL("ic_apk.png", directory)));
}
