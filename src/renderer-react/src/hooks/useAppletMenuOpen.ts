import { useEffect, useState, type RefObject } from "react";

/**
 * Whether a GeoGebra menu is currently open inside the applet.
 *
 * GeoGebra renders its menu bar dropdowns inside the applet's own stacking
 * context, which the floating assistant panel is painted above. While a menu is
 * open the panel has to ignore pointer events, or it swallows the clicks meant
 * for the menu underneath. GeoGebra creates the menu items only while a menu is
 * open, so watching for their presence is enough.
 */
export function useAppletMenuOpen(containerRef: RefObject<HTMLElement | null>) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof MutationObserver === "undefined") return;
    const update = () => setOpen(container.querySelector(".gwt-MenuItem, .gwt-MenuBar-vertical") !== null);
    update();
    // The applet mutates its DOM heavily while rendering. Coalesce to one
    // check per frame so a burst of mutations cannot flood the query.
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    };
    const observer = new MutationObserver(schedule);
    observer.observe(container, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [containerRef]);
  return open;
}
