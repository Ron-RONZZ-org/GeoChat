/**
 * Route GeoGebra's own export commands into a native save dialog.
 *
 * GeoGebra builds exports in the webview and, when `window.ggbExportFile` is
 * defined, hands it a `{ url, name }` pair instead of triggering a download.
 * A plain download has nowhere to go inside the Tauri shell — WebKitGTK has no
 * download handler — so the export used to vanish. Reading the URL back and
 * passing the bytes to the shell's save command gives the user a real save
 * dialog. The web build never installs the hook, so its default download keeps
 * working.
 */
type GeoGebraExportHook = (url: string, name: string) => void;

const DEFAULT_EXPORT_NAME = "geogebra-export.ggb";

declare global {
  interface Window {
    ggbExportFile?: GeoGebraExportHook;
  }
}

export function installGeoGebraExportHandler() {
  if (typeof window === "undefined" || !window.__TAURI_INTERNALS__ || window.ggbExportFile) return;
  window.ggbExportFile = (url, name) => {
    void saveGeoGebraExport(url, name);
  };
}

async function saveGeoGebraExport(url: string, name: string) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`export fetch failed with status ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke<boolean>("save_export_file", {
      fileName: normalizeExportName(name),
      contentsBase64: bytesToBase64(bytes),
    });
  } catch (error) {
    console.error("[ERROR] Failed to save the GeoGebra export", error);
  }
}

/** Keep a suggested name a filesystem can accept on every platform. */
export function normalizeExportName(name: string) {
  const withoutPath = name.trim().slice(name.trim().lastIndexOf("/") + 1);
  const safe = withoutPath.replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_");
  return safe || DEFAULT_EXPORT_NAME;
}

/** Base64 for the invoke boundary, chunked so large exports cannot blow the call stack. */
export function bytesToBase64(bytes: Uint8Array) {
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}
