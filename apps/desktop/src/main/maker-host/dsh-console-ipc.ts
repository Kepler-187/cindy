import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { randomUUID } from 'node:crypto';

import {
  DSH_AGENT_PRESETS_LIST_CHANNEL,
  DSH_CONSOLE_OPEN_CHANNEL,
  type DshAgentPresetOption,
  type DshAgentPresetsListResult,
  type DshConsoleOpenResult,
} from '../../shared/dshConsole.js';
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

function parsePresetOption(value: unknown): DshAgentPresetOption {
  if (!value || typeof value !== 'object') throw new Error('DSH returned an invalid preset');
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== 'string' || !record.id ||
    (record.trust !== 'system' && record.trust !== 'user') ||
    typeof record.isDefault !== 'boolean'
  ) {
    throw new Error('DSH returned an invalid preset');
  }
  for (const key of ['name', 'description', 'broken'] as const) {
    if (record[key] !== undefined && typeof record[key] !== 'string') {
      throw new Error('DSH returned invalid preset metadata');
    }
  }
  return {
    id: record.id,
    trust: record.trust,
    isDefault: record.isDefault,
    ...(typeof record.name === 'string' ? { name: record.name } : {}),
    ...(typeof record.description === 'string' ? { description: record.description } : {}),
    ...(typeof record.broken === 'string' ? { broken: record.broken } : {}),
  };
}

export async function listDshAgentPresets(
  process: Pick<DshConsoleProcess, 'ensureStarted'>,
): Promise<DshAgentPresetsListResult> {
  const consoleUrl = await process.ensureStarted();
  const origin = consoleOrigin(consoleUrl);
  const rpcId = randomUUID();
  const response = await fetch(new URL('/api/agentPreset.list', origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId,
      method: 'agentPreset.list',
      payload: {},
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`DSH preset list failed with HTTP ${response.status}`);
  const envelope = await response.json() as {
    rpcId?: unknown;
    result?: { ok?: unknown; value?: unknown; error?: { message?: unknown } };
  };
  if (envelope.rpcId !== rpcId) throw new Error('DSH preset list returned a mismatched response');
  if (envelope.result?.ok !== true) throw new Error('DSH preset list request failed');
  const value = envelope.result.value;
  if (!value || typeof value !== 'object') throw new Error('DSH preset list returned invalid data');
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.presets) || typeof record.authorable !== 'boolean') {
    throw new Error('DSH preset list returned invalid data');
  }
  return {
    presets: record.presets.map(parsePresetOption),
    authorable: record.authorable,
  };
}

export interface RegisterDshConsoleIpcDeps {
  ipcMain: Pick<IpcMain, 'handle'>;
  process: DshConsoleProcess;
  assertTrustedSender: (event: IpcMainInvokeEvent) => void;
  lookupWebContents: (id: number) => WebContents | undefined;
}

export function registerDshConsoleIpc(deps: RegisterDshConsoleIpcDeps): void {
  deps.ipcMain.handle(
    DSH_AGENT_PRESETS_LIST_CHANNEL,
    async (event: IpcMainInvokeEvent): Promise<DshAgentPresetsListResult> => {
      deps.assertTrustedSender(event);
      try {
        return await listDshAgentPresets(deps.process);
      } catch {
        throwIpcError('INTERNAL', 'Unable to list DSH modes.');
      }
    },
  );
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
