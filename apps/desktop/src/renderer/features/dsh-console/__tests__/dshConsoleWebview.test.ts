import { describe, expect, it, vi } from 'vitest';

import { getDshConsoleWebContentsIdOrPrime } from '../dshConsoleWebview';

describe('getDshConsoleWebContentsIdOrPrime', () => {
  it('primes an unattached empty webview with about:blank', () => {
    const setAttribute = vi.fn();
    const webview = {
      getWebContentsId: vi.fn(() => 0),
      getAttribute: vi.fn(() => null),
      setAttribute,
    };

    expect(getDshConsoleWebContentsIdOrPrime(webview)).toBeNull();
    expect(setAttribute).toHaveBeenCalledWith('src', 'about:blank');
  });

  it('returns an attached guest id without changing its src', () => {
    const setAttribute = vi.fn();
    const webview = {
      getWebContentsId: vi.fn(() => 42),
      getAttribute: vi.fn(() => 'about:blank'),
      setAttribute,
    };

    expect(getDshConsoleWebContentsIdOrPrime(webview)).toBe(42);
    expect(setAttribute).not.toHaveBeenCalled();
  });
});
