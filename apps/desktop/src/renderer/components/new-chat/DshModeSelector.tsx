import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, LoaderCircle, RefreshCw, Workflow } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { DshAgentPresetOption } from '../../../shared/dshConsole';
import { MorphPopover } from '@/components/ui/morph-popover';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface DshModeSelectorProps {
  value?: string;
  onChange: (presetId: string) => void;
  disabled?: boolean;
  dense?: boolean;
  visualVariant?: 'default' | 'create-agent';
}

/** DSH is the source of truth for both built-in and user/plugin Agent presets. */
export function DshModeSelector({
  value,
  onChange,
  disabled = false,
  dense = false,
  visualVariant = 'default',
}: DshModeSelectorProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<DshAgentPresetOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const result = await window.electronAPI.listDshAgentPresets();
      setOptions(result.presets);
      const selected = result.presets.find((preset) => preset.id === value && !preset.broken);
      const fallback = result.presets.find((preset) => preset.isDefault && !preset.broken);
      if (!selected && fallback) onChange(fallback.id);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [onChange, value]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const current = useMemo(
    () => options.find((preset) => preset.id === value),
    [options, value],
  );
  const label = current?.name ?? value ?? t('newChat.dshModeSelector.description');
  const createAgent = visualVariant === 'create-agent';
  const trigger = (
    <Tip text={current?.description ?? t('newChat.dshModeSelector.description')} side="top">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((previous) => !previous)}
        aria-label={t('newChat.dshModeSelector.triggerAria', { label })}
        aria-expanded={open}
        aria-haspopup="listbox"
        className={cn(
          'flex h-[30px] min-w-0 max-w-[180px] items-center gap-1 rounded-full border border-transparent bg-transparent px-2.5',
          'text-[var(--text-primary)] transition-colors',
          'hover:border-[var(--border-default)] hover:bg-[var(--composer-pill-bg,#FCFCFC)] dark:hover:bg-[var(--composer-pill-bg,#393838)]',
          disabled && 'pointer-events-none opacity-50',
        )}
      >
        {loading ? (
          <LoaderCircle size={createAgent ? 11 : dense ? 13 : 14} className="shrink-0 animate-spin" />
        ) : (
          <Workflow size={createAgent ? 11 : dense ? 13 : 14} className="shrink-0" />
        )}
        <span className={cn('min-w-0 truncate', createAgent || dense ? 'text-12' : 'text-13')}>
          {label}
        </span>
        <ChevronDown size={createAgent ? 8 : dense ? 13 : 14} className="shrink-0" />
      </button>
    </Tip>
  );

  return (
    <MorphPopover
      open={open && !disabled}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void refresh();
      }}
      panelWidth={360}
      panelClassName="p-2"
      panelAriaLabel={t('newChat.dshModeSelector.listAria')}
      startBg="var(--composer-pill-bg)"
      startBorderColor="var(--border-default)"
      wrapperClassName="min-w-0 shrink"
      trigger={trigger}
    >
      <div role="listbox" aria-label={t('newChat.dshModeSelector.listAria')} className="flex flex-col gap-0.5">
        {options.map((option) => {
          const selected = option.id === value;
          return (
            <Tip
              key={option.id}
              text={option.broken ?? option.description ?? ''}
              side="right"
              contentClassName="max-w-[320px] whitespace-normal break-words text-left"
            >
              <button
                type="button"
                role="option"
                aria-selected={selected}
                disabled={Boolean(option.broken)}
                onClick={() => {
                  onChange(option.id);
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full items-start gap-3 rounded-[8px] px-3 py-2 text-left transition-colors',
                  'hover:bg-[var(--model-item-hover)]',
                  selected && 'bg-[var(--model-item-hover)]',
                  option.broken && 'cursor-not-allowed opacity-45 hover:bg-transparent',
                )}
              >
                <Workflow size={17} className="mt-0.5 shrink-0 text-[var(--model-item-text)]" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-14 font-medium text-[var(--model-item-text)]">
                    {option.name ?? option.id}
                  </span>
                  {option.description && (
                    <span className="mt-0.5 block text-12 leading-4 text-[var(--text-tertiary)]">
                      {option.description}
                    </span>
                  )}
                </span>
                {selected && <Check size={13} className="mt-1 shrink-0 text-[var(--model-item-check)]" />}
              </button>
            </Tip>
          );
        })}
        {!loading && failed && (
          <button
            type="button"
            onClick={() => void refresh()}
            className="flex items-center justify-center gap-2 rounded-[8px] px-3 py-3 text-13 text-[var(--text-secondary)] hover:bg-[var(--model-item-hover)]"
          >
            <RefreshCw size={14} />
            {t('newChat.dshModeSelector.retry')}
          </button>
        )}
        {!loading && !failed && options.length === 0 && (
          <div className="px-3 py-3 text-13 text-[var(--text-tertiary)]">
            {t('newChat.dshModeSelector.empty')}
          </div>
        )}
      </div>
    </MorphPopover>
  );
}
