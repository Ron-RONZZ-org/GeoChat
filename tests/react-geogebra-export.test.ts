import { describe, expect, test } from "bun:test";
import {
  bytesToBase64,
  installGeoGebraExportHandler,
  normalizeExportName,
} from "../src/renderer-react/src/geogebra/export-file";

describe("GeoGebra export file name", () => {
  test("keeps a normal suggested name", () => {
    expect(normalizeExportName("geogebra-export.ggb")).toBe("geogebra-export.ggb");
  });

  test("strips a directory and rejects filesystem-hostile characters", () => {
    expect(normalizeExportName("/tmp/a:b*c?.ggb")).toBe("a_b_c_.ggb");
  });

  test("falls back when there is no usable name", () => {
    expect(normalizeExportName("   ")).toBe("geogebra-export.ggb");
  });
});

describe("GeoGebra export host hook", () => {
  test("installs only inside the desktop shell", () => {
    const scope = globalThis as unknown as { window?: Record<string, unknown> };
    const previous = scope.window;
    try {
      scope.window = {};
      installGeoGebraExportHandler();
      expect(scope.window.ggbExportFile).toBeUndefined();

      scope.window = { __TAURI_INTERNALS__: {} };
      installGeoGebraExportHandler();
      expect(typeof scope.window.ggbExportFile).toBe("function");
    } finally {
      if (previous === undefined) delete scope.window;
      else scope.window = previous;
    }
  });
});

describe("GeoGebra export bytes", () => {
  test("base64 round-trips the payload", () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    expect(atob(bytesToBase64(bytes))).toBe(String.fromCharCode(...bytes));
  });

  test("encodes payloads larger than one internal chunk", () => {
    const bytes = new Uint8Array(0x20000).fill(65);
    expect(atob(bytesToBase64(bytes)).length).toBe(bytes.length);
  });
});
