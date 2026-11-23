import { WaveformIcon } from "@phosphor-icons/react";
import { useCallback, useState } from "react";
import { cn } from "../lib/format";

interface Props {
  src?: string;
  /** Used when `src` fails, e.g. hq720 thumbnails that do not exist for older videos. */
  fallback?: string;
  alt?: string;
  className?: string;
  iconSize?: number;
}

export function Artwork(props: Props) {
  // Keyed by source so a new image starts from a clean loading state, without a reset effect
  // (an effect could run after a cached image already fired onLoad and leave it stuck invisible).
  return <ArtworkImage key={`${props.src ?? ""}|${props.fallback ?? ""}`} {...props} />;
}

function hasArtwork(img: HTMLImageElement) {
  if (img.naturalWidth <= 1 || img.naturalHeight <= 1) return false;
  // YouTube sometimes sends a decodable 120×90 placeholder for an unavailable
  // rendition. Don't reject default.jpg itself: 120×90 is its real size.
  const missingRendition = img.naturalWidth === 120 && img.naturalHeight === 90 &&
    /^https?:\/\/(?:i\d?\.ytimg\.com|img\.youtube\.com)\/vi(?:_webp)?\/[^/]+\/(?:mqdefault|hqdefault|sddefault|maxresdefault|hq720)(?:_live)?\.(?:jpg|webp)(?:[?#]|$)/i.test(img.currentSrc || img.src);
  return !missingRendition;
}

function ArtworkImage({ src, fallback, alt = "", className, iconSize = 20 }: Props) {
  const [current, setCurrent] = useState(src || fallback);
  const [state, setState] = useState<"loading" | "ok" | "error">(src || fallback ? "loading" : "error");

  const finish = useCallback((img?: HTMLImageElement) => {
    if (img && hasArtwork(img)) setState("ok");
    else if (fallback && current !== fallback) {
      setState("loading");
      setCurrent(fallback);
    } else setState("error");
  }, [current, fallback]);

  // Images served from cache can be complete before React attaches onLoad.
  const imgRef = useCallback((img: HTMLImageElement | null) => {
    if (img?.complete && img.naturalWidth > 0) finish(img);
  }, [finish]);

  return (
    <div data-artwork-state={state} className={cn("relative shrink-0 overflow-hidden bg-surface-3", className)}>
      {state !== "error" && current && (
        <img
          key={current}
          ref={imgRef}
          src={current}
          alt={alt}
          loading="lazy"
          decoding="async"
          draggable={false}
          referrerPolicy="no-referrer"
          onLoad={event => finish(event.currentTarget)}
          onError={() => finish()}
          className={cn(
            "absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ease-out-expo",
            state === "ok" ? "opacity-100" : "opacity-0",
          )}
        />
      )}
      {state === "loading" && <div className="skeleton absolute inset-0" />}
      {state === "error" && (
        <div data-artwork-placeholder="" role={alt ? "img" : undefined} aria-label={alt || undefined}
          aria-hidden={!alt} className="absolute inset-0 grid place-items-center bg-surface-3 text-fg-3">
          <WaveformIcon size={iconSize} weight="light" className="max-h-[55%] max-w-[55%]" aria-hidden="true" />
        </div>
      )}
    </div>
  );
}
