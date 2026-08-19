/** Fixed-purpose IPC channel for opening the local DSH web console. */
export const DSH_CONSOLE_OPEN_CHANNEL = 'dsh-console:open';

export interface DshConsoleOpenResult {
  url: string;
}
