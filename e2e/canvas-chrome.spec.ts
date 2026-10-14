import { expect, test, type Page } from "@playwright/test";

const APPLET_CANVAS = ".GeoGebraFrame canvas";
const TOOLBAR = ".GeoGebraFrame .ggbtoolbarpanel";
const TOUR_OVERLAY = ".react-joyride__overlay";
const CANVAS_INTRO = ".frontend-canvas-intro";
const CANVAS = ".frontend-canvas";
const MOUNT_TIMEOUT = 90_000;
const TITLEBAR_HEIGHT = 48;

/** The first-run tour dims the canvas until skipped, so tests start from a clean surface. */
async function dismissTour(page: Page) {
  await page.getByRole("button", { name: "Skip tour" }).click({ timeout: 5_000 }).catch(() => {});
}

/** Recreate the Tauri shell's floating titlebar over the canvas. */
async function installTauriTitlebar(page: Page) {
  await page.evaluate(() => {
    document.documentElement.classList.add("geochat-tauri-shell");
    const header = document.createElement("header");
    header.className = "window-titlebar";
    const spacer = document.createElement("span");
    spacer.className = "window-titlebar-spacer";
    header.appendChild(spacer);
    document.body.appendChild(header);
  });
  await page.waitForTimeout(500);
}

/**
 * The canvas-chrome contract, exercised through the real GeoGebra runtime.
 *
 * The unit tests cover the controller calls; these prove the vendored applet
 * actually renders the toolbar and removes it again on command, and that
 * switching never rebuilds the applet.
 */
test.describe("GeoGebra canvas chrome", () => {
  test("mounts the applet with the full interface by default", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto("/");

    await expect(page.locator(APPLET_CANVAS).first()).toBeVisible({ timeout: MOUNT_TIMEOUT });
    await expect(page.locator(TOOLBAR).first()).toBeVisible({ timeout: MOUNT_TIMEOUT });

    expect(pageErrors, `unexpected page errors: ${pageErrors.join(" | ")}`).toEqual([]);
  });

  test("switches chrome modes without remounting the applet", async ({ page }) => {
    await page.goto("/");
    await dismissTour(page);

    const frame = page.locator(".GeoGebraFrame").first();
    await expect(frame.locator("canvas").first()).toBeVisible({ timeout: MOUNT_TIMEOUT });

    // Tag the live applet frame. A remount replaces the element, so a missing
    // marker after the switch proves the canvas was rebuilt.
    await frame.evaluate((element) => {
      (element as unknown as { __e2eKept?: string }).__e2eKept = "yes";
    });

    const toolbar = page.locator(TOOLBAR).first();
    await expect(toolbar).toBeVisible({ timeout: MOUNT_TIMEOUT });

    await page.getByRole("button", { name: "Switch to the simple canvas" }).click();
    await expect(toolbar).toBeHidden({ timeout: 20_000 });

    await page.getByRole("button", { name: "Show GeoGebra's full interface" }).click();
    await expect(toolbar).toBeVisible({ timeout: 20_000 });

    const kept = await page
      .locator(".GeoGebraFrame")
      .first()
      .evaluate((element) => (element as unknown as { __e2eKept?: string }).__e2eKept);
    expect(kept).toBe("yes");
  });

  test("a canvas click dismisses the first-run tour and the welcome intro", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(APPLET_CANVAS).first()).toBeVisible({ timeout: MOUNT_TIMEOUT });
    await expect(page.locator(TOUR_OVERLAY)).toHaveCount(1);
    await expect(page.locator(CANVAS_INTRO)).toHaveCount(1);

    // Anywhere on the drawing surface, well clear of the assistant panel.
    await page.mouse.click(320, 400);

    await expect(page.locator(TOUR_OVERLAY)).toHaveCount(0, { timeout: 5_000 });
    await expect(page.locator(CANVAS_INTRO)).toHaveCount(0, { timeout: 5_000 });
  });

  test("opening GeoGebra's file chooser keeps the applet laid out", async ({ page }) => {
    await page.goto("/");
    await dismissTour(page);
    await expect(page.locator(APPLET_CANVAS).first()).toBeVisible({ timeout: MOUNT_TIMEOUT });

    const canvasBox = await page.locator(CANVAS).boundingBox();
    await page.locator(".GeoGebraFrame .rightButtonPanel button").last().click({ force: true });
    await page.locator(".GeoGebraFrame .gwt-MenuItem", { hasText: /^Open$/ }).first().click({ force: true });

    await expect(page.locator(".fileViewContentPanel")).toBeVisible({ timeout: 10_000 });
    // The file view replaces the applet content; the frame must not collapse
    // with it (that used to leave a blank canvas).
    const frameBox = await page.locator(".GeoGebraFrame").boundingBox();
    expect(frameBox?.width ?? 0).toBeGreaterThan((canvasBox?.width ?? 0) - 10);
  });

  test("loads GeoGebra in the app language, English by default", async ({ page }) => {
    await page.goto("/");
    await dismissTour(page);
    await expect(page.locator(APPLET_CANVAS).first()).toBeVisible({ timeout: MOUNT_TIMEOUT });

    await page.locator(".GeoGebraFrame .rightButtonPanel button").last().click({ force: true });
    await expect(page.locator(".GeoGebraFrame .gwt-MenuItem", { hasText: /^New$/ }).first()).toBeVisible({ timeout: 10_000 });
  });

  test("uses the persisted app language for GeoGebra's interface", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("geogebraCopilotLanguage", JSON.stringify("zh-CN")));
    await page.goto("/");
    // A canvas pointer dismisses the welcome and the tour regardless of language.
    await expect(page.locator(APPLET_CANVAS).first()).toBeVisible({ timeout: MOUNT_TIMEOUT });
    await page.mouse.click(320, 400);
    await expect(page.locator(TOUR_OVERLAY)).toHaveCount(0, { timeout: 5_000 });

    await page.locator(".GeoGebraFrame .rightButtonPanel button").last().click({ force: true });
    await expect(page.locator(".GeoGebraFrame .gwt-MenuItem", { hasText: /^新建$/ }).first()).toBeVisible({ timeout: 10_000 });
  });

  test("lets GeoGebra's menu bar receive clicks through the floating panel", async ({ page }) => {
    await page.goto("/");
    await dismissTour(page);
    await expect(page.locator(APPLET_CANVAS).first()).toBeVisible({ timeout: MOUNT_TIMEOUT });

    // The menu button sits in the toolbar; the dropdown it opens runs down the
    // right edge, straight under the assistant panel.
    await page.locator(".GeoGebraFrame .rightButtonPanel button").last().click({ force: true });

    // "Open" sits below the panel's top edge, so it is one of the items the
    // floating panel used to swallow.
    const menuItem = page.locator(".GeoGebraFrame .gwt-MenuItem", { hasText: /^Open$/ }).first();
    await expect(menuItem).toBeVisible({ timeout: 10_000 });

    // The panel must step aside so the pointer reaches the menu underneath.
    await expect(page.locator("#geochat-panel-host")).toHaveClass(/geochat-panel-host-passthrough/);
    const hitsMenu = await menuItem.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const top = document.elementFromPoint(rect.x + 12, rect.y + rect.height / 2);
      return top ? top.closest(".gwt-MenuItem") === element : false;
    });
    expect(hitsMenu).toBe(true);

    // Closing the menu (clicking the canvas, as a user would) gives the panel
    // its pointer events back.
    await page.mouse.click(300, 500);
    await expect(page.locator("#geochat-panel-host")).not.toHaveClass(/geochat-panel-host-passthrough/);
  });

  test("keeps GeoGebra's toolbar clickable under the Tauri window titlebar", async ({ page }) => {
    await page.goto("/");
    await dismissTour(page);
    await expect(page.locator(APPLET_CANVAS).first()).toBeVisible({ timeout: MOUNT_TIMEOUT });

    const toolbar = page.locator(TOOLBAR).first();
    await expect(toolbar).toBeVisible({ timeout: MOUNT_TIMEOUT });

    await installTauriTitlebar(page);

    // The full interface reserves the titlebar strip, so the applet chrome
    // starts below it and is not buried under the drag region.
    const canvasBox = await page.locator(CANVAS).boundingBox();
    expect(canvasBox?.y).toBe(TITLEBAR_HEIGHT);
    const box = await toolbar.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(TITLEBAR_HEIGHT);

    // Hit-test the toolbar through the titlebar: the pointer must land on the
    // toolbar, not on the titlebar that floats above the canvas.
    const hitsToolbar = await page.evaluate(
      ([x, y]) => {
        const element = document.elementFromPoint(x, y);
        return element ? element.closest(".ggbtoolbarpanel") !== null : false;
      },
      [box!.x + 20, box!.y + 20],
    );
    expect(hitsToolbar).toBe(true);

    // The sparse canvas keeps the edge-to-edge layout once the toolbar is gone.
    await page.getByRole("button", { name: "Switch to the simple canvas" }).click();
    await expect(toolbar).toBeHidden({ timeout: 20_000 });
    const simpleCanvasBox = await page.locator(CANVAS).boundingBox();
    expect(simpleCanvasBox?.y).toBe(0);
  });
});
