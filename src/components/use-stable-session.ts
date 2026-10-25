import { useEffect, useRef } from "react";

/** Keeps a transfer alive across React strict-mode's fake unmount. */
export function useStableSession(runId: number | null, runner: (signal: AbortSignal) => void) {
  const runnerRef = useRef(runner);
  runnerRef.current = runner;
  const bag = useRef<{ id: number; ac: AbortController; timer?: number } | null>(null);

  useEffect(() => {
    if (runId == null) {
      if (bag.current?.timer) window.clearTimeout(bag.current.timer);
      bag.current?.ac.abort();
      bag.current = null;
      return;
    }
    if (bag.current?.timer) {
      window.clearTimeout(bag.current.timer);
      bag.current.timer = undefined;
    }
    if (!bag.current || bag.current.id !== runId) {
      bag.current?.ac.abort();
      const ac = new AbortController();
      bag.current = { id: runId, ac };
      runnerRef.current(ac.signal);
    }
    return () => {
      const current = bag.current;
      if (!current || current.id !== runId) return;
      current.timer = window.setTimeout(() => {
        if (bag.current === current) {
          current.ac.abort();
          bag.current = null;
        }
      }, 500);
    };
  }, [runId]);
}
