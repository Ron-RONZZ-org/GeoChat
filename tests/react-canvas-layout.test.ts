import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const app = readFileSync(resolve(root, "src/renderer-react/src/App.tsx"), "utf8");
const panel = readFileSync(resolve(root, "src/renderer-react/src/components/AssistantPanel.tsx"), "utf8");
const wrapper = readFileSync(resolve(root, "src/renderer-react/src/geogebra/ggbdeploy-wrapper.ts"), "utf8");
const styles = readFileSync(resolve(root, "src/renderer-react/src/styles.css"), "utf8");

/**
 * The canvas must stay usable at first launch.
 *
 * Two things used to stand in the way: the onboarding tour's dim overlay
 * swallowed every canvas click, and the floating Tauri titlebar sat on top of
 * GeoGebra's own toolbar so its clicks became window drags. These lock the
 * layout and dismissal contracts that keep the drawing surface reachable.
 */
describe("canvas welcome and window chrome", () => {
  test("a pointer on the canvas dismisses the welcome intro", () => {
    expect(app).toContain("onPointerDownCapture={dismissWelcome}");
    expect(app).toContain("const dismissWelcome = useCallback(() => setCanvasIntroVisible(false), []);");
  });

  test("the tour yields the canvas to clicks outside the assistant panel", () => {
    expect(panel).toContain('closest(".react-joyride__overlay")');
    expect(panel).toContain('closest(".react-joyride__tooltip")');
    expect(panel).toContain("getBoundingClientRect()");
    expect(panel).toContain("onWelcomeDismissed?.()");
  });

  test("the floated titlebar height is a shared token", () => {
    expect(styles).toContain("--geochat-titlebar-height: 48px;");
    expect(styles).toMatch(/\.window-titlebar\s*\{[^}]*height:\s*var\(--geochat-titlebar-height\)/s);
  });

  test("the full GeoGebra interface clears the floating titlebar", () => {
    expect(app).toContain('frontend-shell-canvas-chrome-full');
    expect(styles).toMatch(
      /\.geochat-tauri-shell \.frontend-shell-canvas-chrome-full \.frontend-canvas\s*\{[^}]*top:\s*var\(--geochat-titlebar-height\)/s,
    );
  });

  test("the floating panel yields pointer events while a GeoGebra menu is open", () => {
    expect(app).toContain("useAppletMenuOpen(canvasRef)");
    expect(app).toContain("geochat-panel-host-passthrough");
    expect(styles).toContain(".geochat-panel-host-passthrough { pointer-events: none; }");
  });
});

describe("applet layout and language", () => {
  test("the applet parameters are explicitly sized so a GeoGebra view cannot collapse the frame", () => {
    expect(styles).toMatch(
      /\.frontend-canvas-host \.applet_scaler, \.frontend-canvas-host \.appletParameters, \.frontend-canvas-host \.GeoGebraFrame \{[^}]*width: 100% !important/s,
    );
  });

  test("GeoGebra mounts in the app language, English by default", () => {
    expect(wrapper).toContain('language: options.language ?? "en"');
    expect(wrapper).not.toContain('language: "zh-CN"');
    expect(app).toContain("language: currentAppLanguage()");
    expect(app).toContain("controllerRef.current.setLanguage(appLanguage)");
  });
});
