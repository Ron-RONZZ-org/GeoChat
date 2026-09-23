import { expect, test, type Page } from "@playwright/test";

const APPLET_CANVAS = ".GeoGebraFrame canvas";
const TOOLBAR = ".GeoGebraFrame .ggbtoolbarpanel";
const MOUNT_TIMEOUT = 90_000;

/** The first-run tour overlays the canvas and swallows clicks. */
async function dismissTour(page: Page) {
  await page.getByRole("button", { name: "Skip tour" }).click({ timeout: 5_000 }).catch(() => {});
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
});
