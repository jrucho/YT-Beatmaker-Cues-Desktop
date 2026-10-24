import assert from "node:assert/strict";
import { createServer } from "node:http";
import { build } from "../server/node_modules/esbuild/lib/main.js";
const result = await build({ entryPoints: ["server/src/audioRanges.ts"], bundle: true, write: false, format: "esm", platform: "node" });
const { rangedAudio } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
const bytes = Buffer.alloc(2_700_123); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
let retries = 0;
const server = createServer((req, res) => {
  const [, a, b] = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  const start = a ? Number(a) : Math.max(0, bytes.length - Number(b));
  const end = a ? Math.min(Number(b), bytes.length - 1) : bytes.length - 1;
  if (req.url === "/retry" && retries++ === 0) { res.destroy(); return; }
  res.writeHead(206, { "content-range": `bytes ${req.url === "/bad" ? start + 1 : start}-${end}/${bytes.length}`, "content-length": end - start + 1 });
  res.end(bytes.subarray(start, end + 1));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
try {
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [range, start, end] of [[undefined, 0, bytes.length - 1], ["bytes=17-", 17, bytes.length - 1], ["bytes=123-1456789", 123, 1456789], ["bytes=-77", bytes.length - 77, bytes.length - 1], ["bytes=-1500000", bytes.length - 1500000, bytes.length - 1]]) {
    const result = await rangedAudio({ url: base, headers: {} }, range, new AbortController().signal);
    const parts = []; for await (const part of result.body) parts.push(part);
    assert.deepEqual(Buffer.concat(parts), bytes.subarray(start, end + 1));
    assert.equal(result.start, start); assert.equal(result.end, end);
  }
  const retried = await rangedAudio({ url: base + "/retry", headers: {} }, undefined, new AbortController().signal);
  for await (const part of retried.body) assert(part.length > 0);
  await assert.rejects(rangedAudio({ url: base + "/bad", headers: {} }, undefined, new AbortController().signal));
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(rangedAudio({ url: base, headers: {} }, undefined, cancelled.signal));
  console.log("PASS: bounded complete audio, open/closed/suffix ranges, retry, validation and cancellation");
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
