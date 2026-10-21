// Regenerate the checked-in iOS artwork. The Xcode project itself does not need Node or Chrome to use it.
import { chromium } from "../../node_modules/playwright/index.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const assets = new URL("../ios/App/App/Assets.xcassets/", import.meta.url);
const vector = readFileSync(new URL("../android/app/src/main/res/drawable/splash_logo.xml", import.meta.url), "utf8");
const paths = [...vector.matchAll(/android:pathData="([^"]+)"/g)].map((match, i) =>
  `<path d="${match[1]}" ${i === 0 ? 'fill="#C3EC52" fill-rule="evenodd"' : 'fill="none" stroke="#C3EC52" stroke-width="3.2"'}/>`).join("");
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
try {
  for (const [size, name, background, scale, offset] of [
    [1024, "AppIcon.appiconset/AppIcon-512@2x.png", "#0B0C0F", 13.333333, 192],
    [88, "Splash.imageset/splash.png", "transparent", 1.833333, 0],
    [176, "Splash.imageset/splash@2x.png", "transparent", 3.666667, 0],
    [264, "Splash.imageset/splash@3x.png", "transparent", 5.5, 0],
  ]) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<style>html,body{margin:0;background:${background}}svg{display:block}</style><svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><g transform="translate(${offset} ${offset}) scale(${scale})">${paths}</g></svg>`);
    await page.screenshot({ path: fileURLToPath(new URL(name, assets)), omitBackground: background === "transparent" });
    await page.close();
  }
} finally { await browser.close(); }
