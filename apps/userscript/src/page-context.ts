/**
 * Resolve the webpage global from Violentmonkey's Firefox content context.
 *
 * In `@inject-into content`, `unsafeWindow` is still a content-script
 * global. The Perchance editor APIs live on its Firefox `wrappedJSObject`.
 * This only reads the page realm; it never exports privileged GM callbacks.
 */
export function resolveNativePageRealm(
  isolatedWindow: unknown,
  unsafe: unknown,
): unknown {
  for (const context of [unsafe, isolatedWindow]) {
    if (context === null || (typeof context !== "object" && typeof context !== "function")) continue;
    try {
      const page = (context as { wrappedJSObject?: unknown }).wrappedJSObject;
      if (page !== null && (typeof page === "object" || typeof page === "function"))
        return page;
    } catch {
      // The page bridge is unavailable; keep the manager usable but let the
      // native adapter's capability probe fail closed.
    }
  }
  return unsafe ?? isolatedWindow;
}
