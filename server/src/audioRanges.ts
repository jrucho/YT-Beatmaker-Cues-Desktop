import { Readable } from "node:stream";
import type { StreamFormat } from "./ytdlp.js";

const CHUNK = 1024 * 1024;
type Chunk = { data: Uint8Array; start: number; end: number; total: number; response: Response };

/** Buffer one bounded request so truncated upstream responses can be retried before publication. */
async function chunk(format: StreamFormat, start: number | null, end: number | null, suffix: number | null, signal: AbortSignal): Promise<Chunk> {
  let failure: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted();
    try {
      const range = suffix != null ? `bytes=-${suffix}` : `bytes=${start}-${end}`;
      const response = await fetch(format.url, { headers: { ...format.headers, Range: range, "Accept-Encoding": "identity" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
      if (response.status !== 206 || !match) {
        await response.body?.cancel();
        throw new Error(`Audio byte range refused (HTTP ${response.status})`);
      }
      const [from, to, total] = match.slice(1).map(Number);
      if (![from, to, total].every(Number.isSafeInteger) || total <= 0 || from < 0 || to < from || to >= total
          || (start != null && from !== start) || (end != null && to > end)
          || (suffix != null && (from !== Math.max(0, total - suffix) || to !== total - 1))) {
        await response.body?.cancel();
        throw new Error("Inconsistent audio byte range");
      }
      if (to - from + 1 > CHUNK) { await response.body?.cancel(); throw new Error("Audio range exceeds chunk limit"); }
      const data = new Uint8Array(await response.arrayBuffer());
      if (data.byteLength !== to - from + 1) throw new Error("Incomplete audio byte range");
      return { data, start: from, end: to, total, response };
    } catch (error) { failure = error; }
  }
  throw failure;
}

/** Stream bounded chunks with backpressure, retaining the browser's HTTP Range semantics. */
export async function rangedAudio(format: StreamFormat, range: string | undefined, signal: AbortSignal) {
  const parsed = range == null ? null : /^bytes=(\d*)-(\d*)$/.exec(range);
  if (range != null && (!parsed || (!parsed[1] && !parsed[2]))) throw new Error("Invalid audio range");
  const suffix = parsed && !parsed[1] ? Number(parsed[2]) : null;
  if (suffix != null && (!Number.isSafeInteger(suffix) || suffix <= 0)) throw new Error("Invalid suffix range");
  const start = suffix != null ? null : Number(parsed?.[1] || 0);
  const requestedEnd = parsed?.[1] && parsed[2] ? Number(parsed[2]) : null;
  if ((start != null && (!Number.isSafeInteger(start) || start < 0))
      || (requestedEnd != null && (!Number.isSafeInteger(requestedEnd) || requestedEnd < start!))) throw new Error("Invalid audio range");
  // Discover total size with a small tail probe for suffix requests.
  let first = await chunk(format, start, start == null ? null : Math.min(start + CHUNK - 1, requestedEnd ?? Infinity),
    suffix == null ? null : Math.min(suffix, CHUNK), signal);
  const total = first.total;
  if (suffix != null && suffix > CHUNK) {
    const from = Math.max(0, total - suffix);
    first = await chunk(format, from, Math.min(total - 1, from + CHUNK - 1), null, signal);
  }
  const end = suffix != null ? total - 1 : Math.min(requestedEnd ?? total - 1, total - 1);
  const from = first.start;
  const body = Readable.from((async function* () {
    let current = first;
    while (true) {
      signal.throwIfAborted();
      yield current.data;
      const next = current.end + 1;
      if (next > end) break;
      current = await chunk(format, next, Math.min(next + CHUNK - 1, end), null, signal);
      if (current.total !== total) throw new Error("Audio changed during transfer");
    }
  })());
  return { body, start: from, end, total, partial: range != null };
}
