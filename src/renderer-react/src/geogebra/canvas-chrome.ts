import type { GeoGebraApi } from "./ggbdeploy-wrapper";

/**
 * The two canvas presentations GeoChat offers.
 *
 * "full" surfaces GeoGebra's own toolbar and menu bar, so every native tool and
 * view is reachable. "canvas" keeps the sparse drawing surface the product was
 * designed around. Both are switchable at runtime, so changing mode never
 * remounts the applet and never disturbs the construction.
 */
export type CanvasChromeMode = "full" | "canvas";

export const DEFAULT_CANVAS_CHROME: CanvasChromeMode = "full";

const STORAGE_KEY = "geochatDesktopCanvasChrome";
const listeners = new Set<() => void>();
let currentMode = readStoredMode();

function isCanvasChromeMode(value: unknown): value is CanvasChromeMode {
  return value === "full" || value === "canvas";
}

function readStoredMode(): CanvasChromeMode {
  if (typeof window === "undefined") return DEFAULT_CANVAS_CHROME;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isCanvasChromeMode(stored) ? stored : DEFAULT_CANVAS_CHROME;
  } catch (caughtError) {
    console.error("[ERROR] Failed to read the canvas chrome preference", caughtError);
    return DEFAULT_CANVAS_CHROME;
  }
}

export function getCanvasChromeMode(): CanvasChromeMode {
  return currentMode;
}

export function setCanvasChromeMode(mode: CanvasChromeMode) {
  if (mode === currentMode) return;
  currentMode = mode;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, mode);
    } catch (caughtError) {
      console.error("[ERROR] Failed to persist the canvas chrome preference", caughtError);
      // A blocked store only costs the preference on the next launch.
    }
  }
  for (const listener of listeners) listener();
}

export function subscribeCanvasChrome(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * GeoGebra exposes a runtime toggle per chrome region, so this applies to the
 * live applet instead of rebuilding it. The bottom algebra input bar is
 * intentionally left out: it sits under the shell's own canvas controls, and
 * the same input is reachable from the Algebra view in the menu bar.
 */
export function applyCanvasChrome(api: GeoGebraApi, mode: CanvasChromeMode) {
  const show = mode === "full";
  for (const method of ["showToolBar", "showMenuBar"] as const) {
    const toggle = api[method];
    if (typeof toggle !== "function") continue;
    try {
      Reflect.apply(toggle, api, [show]);
    } catch (caughtError) {
      console.error(`[ERROR] GeoGebra ${method} failed while applying the canvas chrome`, caughtError);
    }
  }
}
