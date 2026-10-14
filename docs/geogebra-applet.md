# GeoGebra Applet Vendor Source

## Vendored Runtime

The desktop project vendors the GeoGebra applet runtime under `vendor/geogebra`
so the Tauri app can serve the applet from the local Bun backend.

- Desktop copy: `vendor/geogebra`
- Copied footprint: about 159 MB, 659 files

The renderer constructs the asset URLs as:

- `deployggb.js`: `${GEOGEBRA_ASSET_BASE}/deployggb.js`
- HTML5 codebase: `${GEOGEBRA_ASSET_BASE}/HTML5/5.0/web3d/`

In the desktop app, `GEOGEBRA_ASSET_BASE` defaults to the local backend route:

```text
http://127.0.0.1:8000/tools/geogebra-assets-v2
```

or can be overridden with:

```text
VITE_GEOGEBRA_ASSET_BASE
```

## Desktop Integration Notes

The Tauri desktop app serves `vendor/geogebra` through the local Bun backend.
That keeps the desktop app self-contained.

Current local route:

```text
/tools/geogebra-assets-v2 -> vendor/geogebra
```

The React wrapper in `src/renderer-react/src/geogebra/ggbdeploy-wrapper.ts` owns the runtime contract:

- inject the applet using `new window.GGBApplet(...)`
- set the HTML5 codebase to `HTML5/5.0/web3d/`
- maintain per-board controller state instead of relying on a single global `window.ggbApplet`
- expose command execution, canvas context, and PNG export as desktop app services

The canvas can present GeoGebra's own toolbar and menu bar or the sparse drawing
surface. `src/renderer-react/src/geogebra/canvas-chrome.ts` owns the preference
(default: full interface) and applies it through GeoGebra's runtime
`showToolBar` / `showMenuBar` toggles, so switching never remounts the applet or
resets the construction. Both the General settings tab and a canvas control edit
it.

The desktop shell floats its own titlebar over the canvas so the drawing area
keeps every pixel. GeoGebra's toolbar occupies that same top strip, so in the
full interface the shell pushes the canvas down by the titlebar height
(`--geochat-titlebar-height`). Without that reservation the titlebar would sit
on top of the toolbar and turn every tool click into a window drag. The sparse
canvas has nothing in that strip and stays edge to edge.

GeoGebra's menu bar opens inside the applet, beneath the floating assistant
panel. While a menu is open the panel is marked `geochat-panel-host-passthrough`
so pointer events reach the menu; the marker clears when the menu closes.

The applet runs in the app language: `mountGeoGebra` takes a `language`, which
the renderer resolves from the persisted app-language setting (default English,
never the hosted runtime's own default). A language change is forwarded through
`ggbApplet.setLanguage` on the live applet, so it does not remount or reset the
construction.

`.appletParameters` is an inline-block with no intrinsic width. The stylesheet
sizes it (and the scaler and frame) explicitly, because otherwise the frame's
percentage width resolves against a shrink-to-fit box and collapses the whole
applet when a GeoGebra view — such as the file chooser — replaces the canvas.

## Saving Exports

GeoGebra hands finished exports to `window.ggbExportFile(url, name)` when the
host defines it, otherwise it triggers a plain download. A download has no
destination in the Tauri shell (WebKitGTK has no download handler), so
`src/renderer-react/src/geogebra/export-file.ts` installs the hook only inside
the desktop shell: it reads the export URL back as bytes and calls the
`save_export_file` command, which shows a native save dialog. The web build
leaves the hook undefined and keeps GeoGebra's default download.
