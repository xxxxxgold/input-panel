export function stubWindow(value: Window & typeof globalThis) {
  Object.defineProperty(globalThis, "window", {
    value,
    configurable: true,
    writable: true
  });
}

export function restoreWindow(originalWindow: typeof globalThis.window | undefined) {
  if (originalWindow) {
    globalThis.window = originalWindow;
    return;
  }

  Reflect.deleteProperty(globalThis, "window");
}
