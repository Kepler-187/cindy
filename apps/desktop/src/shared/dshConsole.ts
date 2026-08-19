/** Fixed-purpose IPC channel for opening the local DSH web console. */
export const DSH_CONSOLE_OPEN_CHANNEL = 'dsh-console:open';
export const DSH_AGENT_PRESETS_LIST_CHANNEL = 'dsh-console:agent-presets-list';

export interface DshConsoleOpenResult {
  url: string;
}

export interface DshAgentPresetOption {
  id: string;
  trust: 'system' | 'user';
  isDefault: boolean;
  name?: string;
  description?: string;
  broken?: string;
}

export interface DshAgentPresetsListResult {
  presets: DshAgentPresetOption[];
  authorable: boolean;
}
