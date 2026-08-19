import { describe, expect, it, vi } from 'vitest';

import {
  DSH_AGENT_PRESETS_LIST_CHANNEL,
  DSH_CONSOLE_OPEN_CHANNEL,
} from '../../../shared/dshConsole.js';
import {
  installDshConsoleGuestHandlers,
  isAllowedDshConsoleNavigation,
  listDshAgentPresets,
  registerDshConsoleIpc,
} from '../dsh-console-ipc.js';

function createGuest(ownerId = 10) {
  const listeners = new Map<string, (event: { preventDefault(): void }, url: string) => void>();
  return {
    id: 20,
    hostWebContents: { id: ownerId },
    getType: () => 'webview',
    isDestroyed: () => false,
    on: vi.fn(
      (event: string, listener: (event: { preventDefault(): void }, url: string) => void) => {
        listeners.set(event, listener);
      },
    ),
    setWindowOpenHandler: vi.fn(),
    listeners,
  };
}

describe('registerDshConsoleIpc', () => {
  it('guards the sender before starting and opens only the main-owned URL', async () => {
    let handler: ((event: unknown, webContentsId: unknown) => Promise<unknown>) | undefined;
    const assertTrustedSender = vi.fn();
    const ensureStarted = vi.fn().mockResolvedValue('http://127.0.0.1:45678/');
    const guest = createGuest();

    registerDshConsoleIpc({
      ipcMain: {
        handle: vi.fn((channel, next) => {
          if (channel === DSH_CONSOLE_OPEN_CHANNEL) handler = next as typeof handler;
        }),
      },
      process: { ensureStarted } as never,
      assertTrustedSender: assertTrustedSender as never,
      lookupWebContents: vi.fn(() => guest as never),
    });

    const event = { sender: { id: 10 } };
    await expect(handler!(event, 20)).resolves.toEqual({ url: 'http://127.0.0.1:45678/' });
    expect(assertTrustedSender).toHaveBeenCalledWith(event);
    expect(ensureStarted).toHaveBeenCalledTimes(1);
    expect(guest.setWindowOpenHandler).toHaveBeenCalledTimes(1);
    expect(assertTrustedSender.mock.invocationCallOrder[0]).toBeLessThan(
      ensureStarted.mock.invocationCallOrder[0]!,
    );
  });

  it('does not start the console for an untrusted renderer', async () => {
    let handler: ((event: unknown, webContentsId: unknown) => Promise<unknown>) | undefined;
    const ensureStarted = vi.fn();
    registerDshConsoleIpc({
      ipcMain: {
        handle: vi.fn((channel, next) => {
          if (channel === DSH_CONSOLE_OPEN_CHANNEL) handler = next as typeof handler;
        }),
      },
      process: { ensureStarted } as never,
      assertTrustedSender: (() => {
        throw new Error('untrusted');
      }) as never,
      lookupWebContents: vi.fn(),
    });

    await expect(handler!({}, 20)).rejects.toThrow('untrusted');
    expect(ensureStarted).not.toHaveBeenCalled();
  });

  it('rejects a guest that is not hosted by the calling renderer before startup', async () => {
    let handler: ((event: unknown, webContentsId: unknown) => Promise<unknown>) | undefined;
    const ensureStarted = vi.fn();
    const foreignGuest = createGuest(99);
    registerDshConsoleIpc({
      ipcMain: {
        handle: vi.fn((channel, next) => {
          if (channel === DSH_CONSOLE_OPEN_CHANNEL) handler = next as typeof handler;
        }),
      },
      process: { ensureStarted } as never,
      assertTrustedSender: vi.fn(),
      lookupWebContents: vi.fn(() => foreignGuest as never),
    });

    await expect(handler!({ sender: { id: 10 } }, 20)).rejects.toThrow(
      'webContentsId is not a webview hosted by the sender',
    );
    expect(ensureStarted).not.toHaveBeenCalled();
  });

  it('lists the live DSH preset roster without hardcoding plugin-provided ids', async () => {
    const ensureStarted = vi.fn().mockResolvedValue('http://127.0.0.1:45678/');
    const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { rpcId: string };
      return new Response(
        JSON.stringify({
          rpcId: request.rpcId,
          result: {
            ok: true,
            value: {
              authorable: true,
              presets: [
                { id: 'standard', name: 'Standard', trust: 'system', isDefault: true },
                {
                  id: 'plugin/architecture-review',
                  name: 'Architecture review',
                  description: 'Added by a DSH plugin',
                  trust: 'user',
                  isDefault: false,
                },
              ],
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(listDshAgentPresets({ ensureStarted } as never)).resolves.toEqual({
        authorable: true,
        presets: [
          { id: 'standard', name: 'Standard', trust: 'system', isDefault: true },
          {
            id: 'plugin/architecture-review',
            name: 'Architecture review',
            description: 'Added by a DSH plugin',
            trust: 'user',
            isDefault: false,
          },
        ],
      });
      expect(ensureStarted).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        new URL('http://127.0.0.1:45678/api/agentPreset.list'),
        expect.objectContaining({ method: 'POST' }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('guards the preset roster channel before starting DSH', async () => {
    const handlers = new Map<string, (event: unknown) => Promise<unknown>>();
    const ensureStarted = vi.fn();
    registerDshConsoleIpc({
      ipcMain: {
        handle: vi.fn((channel, next) => handlers.set(channel, next as never)),
      },
      process: { ensureStarted } as never,
      assertTrustedSender: (() => {
        throw new Error('untrusted');
      }) as never,
      lookupWebContents: vi.fn(),
    });

    await expect(handlers.get(DSH_AGENT_PRESETS_LIST_CHANNEL)!({})).rejects.toThrow('untrusted');
    expect(ensureStarted).not.toHaveBeenCalled();
  });
});

describe('DSH console guest navigation guard', () => {
  it('allows only the exact loopback origin and denies every popup', () => {
    const guest = createGuest();
    installDshConsoleGuestHandlers(guest as never, 'http://127.0.0.1:45678/');

    expect(
      isAllowedDshConsoleNavigation('http://127.0.0.1:45678/settings', 'http://127.0.0.1:45678'),
    ).toBe(true);
    expect(isAllowedDshConsoleNavigation('http://127.0.0.1:45679/', 'http://127.0.0.1:45678')).toBe(
      false,
    );
    expect(isAllowedDshConsoleNavigation('https://example.com/', 'http://127.0.0.1:45678')).toBe(
      false,
    );
    expect(
      guest.setWindowOpenHandler.mock.calls[0]![0]({ url: 'http://127.0.0.1:45678/' }),
    ).toEqual({ action: 'deny' });

    const sameOriginEvent = { preventDefault: vi.fn() };
    guest.listeners.get('will-navigate')!(sameOriginEvent, 'http://127.0.0.1:45678/session/1');
    expect(sameOriginEvent.preventDefault).not.toHaveBeenCalled();

    const crossOriginEvent = { preventDefault: vi.fn() };
    guest.listeners.get('will-redirect')!(crossOriginEvent, 'http://127.0.0.1:9999/');
    expect(crossOriginEvent.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('updates the allowed origin without stacking navigation listeners', () => {
    const guest = createGuest();
    installDshConsoleGuestHandlers(guest as never, 'http://127.0.0.1:45678/');
    installDshConsoleGuestHandlers(guest as never, 'http://127.0.0.1:56789/');
    expect(guest.on).toHaveBeenCalledTimes(2);

    const staleOrigin = { preventDefault: vi.fn() };
    guest.listeners.get('will-navigate')!(staleOrigin, 'http://127.0.0.1:45678/');
    expect(staleOrigin.preventDefault).toHaveBeenCalledTimes(1);

    const currentOrigin = { preventDefault: vi.fn() };
    guest.listeners.get('will-navigate')!(currentOrigin, 'http://127.0.0.1:56789/');
    expect(currentOrigin.preventDefault).not.toHaveBeenCalled();
  });
});
