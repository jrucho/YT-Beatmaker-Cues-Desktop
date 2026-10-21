import { useEffect, useState } from "react";

/**
 * The first thing after the native splash: the mark builds itself pad by pad, then the app shows through.
 * It only runs when the app opens (this component is mounted once, from main.tsx), never on navigation.
 */
export function Intro() {
  const [done, setDone] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setDone(true), 1500);
    return () => window.clearTimeout(timer);
  }, []);

  if (done) return null;
  return (
    <div className="boot" aria-hidden="true">
      <div className="boot-glow" />
      <div className="boot-mark">
        <span className="boot-pad boot-pad-1" />
        <span className="boot-pad boot-pad-2" />
        <span className="boot-pad boot-pad-3" />
        <span className="boot-pad boot-pad-4" />
      </div>
      <p className="boot-name">Beatmaker Cues</p>
    </div>
  );
}
