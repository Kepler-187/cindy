import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';

import { DSH_CONSOLE_OPEN_CHANNEL, type DshConsoleOpenResult } from '../../shared/dshConsole.js';
import { requireNonNegativeInt, throwIpcError } from '../utils/ipcValidate.js';
import type { DshConsoleProcess } from './dsh-console-process.js';

type DshConsoleGuest = Pick<
  WebContents,
  'getType' | 'hostWebContents' | 'id' | 'isDestroyed' | 'on' | 'setWindowOpenHandler'
>;

const consoleOrigins = new WeakMap<DshConsoleGuest, string>();

function consoleOrigin(consoleUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(consoleUrl);
  } catch {
    throw new Error('DSH console returned an invalid URL');
  }
  if (
    parsed.protocol !== 'http:' ||
    parsed.hostname !== '127.0.0.1' ||
    !parsed.port ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error('DSH console returned a non-loopback URL');
  }
  return parsed.origin;
}

export function isAllowedDshConsoleNavigation(url: string, allowedOrigin: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'http:' &&
      parsed.hostname === '127.0.0.1' &&
      parsed.origin === allowedOrigin &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}

export function installDshConsoleGuestHandlers(guest: DshConsoleGuest, consoleUrl: string): void {
  const origin = consoleOrigin(consoleUrl);
  const alreadyBound = consoleOrigins.has(guest);
  consoleOrigins.set(guest, origin);
  guest.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (alreadyBound) return;

  const guardNavigation = (event: { preventDefault(): void }, url: string): void => {
    const currentOrigin = consoleOrigins.get(guest);
    if (!currentOrigin || !isAllowedDshConsoleNavigation(url, currentOrigin)) {
      event.preventDefault();
    }
  };
  guest.on('will-navigate', guardNavigation);
  guest.on('will-redirect', guardNavigation);
}

export interface RegisterDshConsoleIpcDeps {
  ipcMain: Pick<IpcMain, 'handle'>;
  process: DshConsoleProcess;
  assertTrustedSender: (event: IpcMainInvokeEvent) => void;
  lookupWebContents: (id: number) => WebContents | undefined;
}

export function registerDshConsoleIpc(deps: RegisterDshConsoleIpcDeps): void {
  deps.ipcMain.handle(
    DSH_CONSOLE_OPEN_CHANNEL,
    async (event: IpcMainInvokeEvent, rawWebContentsId: unknown): Promise<DshConsoleOpenResult> => {
      deps.assertTrustedSender(event);
      const webContentsId = requireNonNegativeInt(rawWebContentsId, 'webContentsId');
      const guest = deps.lookupWebContents(webContentsId);
      if (!guest || guest.isDestroyed()) {
        throwIpcError('INVALID_PARAMS', `webContentsId ${webContentsId} does not resolve`);
      }
      if (guest.getType() !== 'webview' || guest.hostWebContents?.id !== event.sender.id) {
        throwIpcError('INVALID_PARAMS', 'webContentsId is not a webview hosted by the sender');
      }
      try {
        const url = await deps.process.ensureStarted();
        installDshConsoleGuestHandlers(guest, url);
        return { url };
      } catch {
        throwIpcError('INTERNAL', 'Unable to open the DSH console.');
      }
    },
  );
}
