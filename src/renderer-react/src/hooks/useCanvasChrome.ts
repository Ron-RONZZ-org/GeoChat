import { useCallback, useSyncExternalStore } from "react";
import {
  DEFAULT_CANVAS_CHROME,
  getCanvasChromeMode,
  setCanvasChromeMode,
  subscribeCanvasChrome,
  type CanvasChromeMode,
} from "../geogebra/canvas-chrome";

/** Share the canvas presentation preference between settings and the canvas control. */
export function useCanvasChrome() {
  const mode = useSyncExternalStore(subscribeCanvasChrome, getCanvasChromeMode, () => DEFAULT_CANVAS_CHROME);
  const setMode = useCallback((next: CanvasChromeMode) => setCanvasChromeMode(next), []);
  const toggle = useCallback(() => setCanvasChromeMode(getCanvasChromeMode() === "full" ? "canvas" : "full"), []);
  return { mode, setMode, toggle };
}
