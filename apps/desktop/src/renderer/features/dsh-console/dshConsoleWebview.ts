interface DshConsoleWebviewAttachment {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  getWebContentsId(): number;
}

/**
 * An Electron webview without a src does not create a guest WebContents. Prime
 * it with an inert document so Main can verify the real guest before it returns
 * the loopback console URL.
 */
export function getDshConsoleWebContentsIdOrPrime(
  webview: DshConsoleWebviewAttachment,
): number | null {
  try {
    const id = webview.getWebContentsId();
    if (Number.isInteger(id) && id > 0) return id;
  } catch {
    // The guest has not attached yet.
  }
  if (!webview.getAttribute('src')) webview.setAttribute('src', 'about:blank');
  return null;
}
