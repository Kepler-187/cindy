import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, LoaderCircle, RotateCw, X } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useRegisterCCAgentSidebar } from '@/features/cc-agent/useRegisterCCAgentSidebar';
import { useBrowserWebview } from '@/features/right-sidebar/hooks/useBrowserWebview';
import { browserWebviewPool } from '@/features/right-sidebar/lib/browserWebviewPool';
import { cn } from '@/lib/utils';

import { getDshConsoleWebContentsIdOrPrime } from './dshConsoleWebview';

const CONSOLE_TAB_ID = 'dsh-console:main';

export function DshConsoleView(): React.ReactElement {
  useRegisterCCAgentSidebar();
  const { t } = useTranslation();
  const location = useLocation();
  const [consoleUrl, setConsoleUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const slotRef = useRef<HTMLDivElement>(null);
  const navigatedWrapperRef = useRef<HTMLDivElement | null>(null);
  const browser = useBrowserWebview(CONSOLE_TAB_ID, undefined, true);

  useEffect(() => {
    const webview = browser.webview;
    if (!webview) return;
    let disposed = false;
    let opening = false;
    const start = async (): Promise<void> => {
      if (opening) return;
      const webContentsId = getDshConsoleWebContentsIdOrPrime(webview);
      if (webContentsId === null) return;
      opening = true;
      setError(false);
      setConsoleUrl(null);
      try {
        const { url } = await window.electronAPI.openDshConsole(webContentsId);
        if (!disposed) setConsoleUrl(url);
      } catch {
        if (!disposed) setError(true);
      } finally {
        opening = false;
      }
    };
    const onDidAttach = (): void => {
      void start();
    };
    webview.addEventListener('did-attach', onDidAttach);
    void start();
    return () => {
      disposed = true;
      webview.removeEventListener('did-attach', onDidAttach);
    };
  }, [attempt, browser.webview, location.key]);

  useLayoutEffect(() => {
    const slot = slotRef.current;
    const wrapper = browser.wrapper;
    if (!slot || !wrapper) return;
    slot.appendChild(wrapper);
    return () => {
      if (browserWebviewPool.peek(CONSOLE_TAB_ID)?.wrapper !== wrapper) {
        wrapper.remove();
        return;
      }
      const parking = document.getElementById('browser-webview-pool');
      if (parking) parking.appendChild(wrapper);
      else wrapper.remove();
    };
  }, [browser.wrapper]);

  useEffect(() => {
    const wrapper = browser.wrapper;
    if (!wrapper || !consoleUrl) return;
    if (navigatedWrapperRef.current === wrapper && browser.url === consoleUrl) return;
    navigatedWrapperRef.current = wrapper;
    browser.navigate(consoleUrl);
  }, [browser.navigate, browser.url, browser.wrapper, consoleUrl]);

  const waitingForBackend = !consoleUrl && !error;

  return (
    <div className="flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden bg-content-area">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-[var(--border-default)] bg-[var(--surface)] px-2">
        <button
          type="button"
          onClick={browser.goBack}
          disabled={!browser.canGoBack}
          aria-label={t('rightSidebar.browser.goBack')}
          className="flex size-7 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-35"
        >
          <ArrowLeft size={15} aria-hidden />
        </button>
        <button
          type="button"
          onClick={browser.goForward}
          disabled={!browser.canGoForward}
          aria-label={t('rightSidebar.browser.goForward')}
          className="flex size-7 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-35"
        >
          <ArrowRight size={15} aria-hidden />
        </button>
        <button
          type="button"
          onClick={browser.isLoading ? browser.stop : browser.reload}
          disabled={!consoleUrl}
          aria-label={
            browser.isLoading ? t('rightSidebar.browser.stop') : t('rightSidebar.browser.reload')
          }
          className="flex size-7 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-35"
        >
          {browser.isLoading ? <X size={14} aria-hidden /> : <RotateCw size={14} aria-hidden />}
        </button>
        <div className="ml-1 min-w-0 flex-1 truncate rounded-full border border-[var(--border-default)] bg-[var(--surface-secondary)] px-3 py-1 text-xs text-[var(--text-secondary)]">
          {browser.url || consoleUrl || t('sidebar.dshConsoleStarting')}
        </div>
      </div>

      <div ref={slotRef} className="relative min-h-0 flex-1 overflow-hidden">
        {(waitingForBackend || error || browser.crash) && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-content-area px-6 text-center">
            {waitingForBackend ? (
              <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                <span className="animate-spin" aria-hidden>
                  <LoaderCircle size={16} />
                </span>
                <span>{t('sidebar.dshConsoleStarting')}</span>
              </div>
            ) : (
              <div className="flex max-w-sm flex-col items-center gap-3">
                <p className="text-sm text-[var(--text-secondary)]">
                  {t('sidebar.dshConsoleOpenFailed')}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    if (browser.crash) browser.reload();
                    setAttempt((value) => value + 1);
                  }}
                  className={cn(
                    'inline-flex h-8 items-center gap-2 rounded-full px-4 text-sm font-medium',
                    'bg-[var(--accent-cta-bg)] text-[var(--accent-cta-fg)] hover:bg-[var(--accent-cta-bg-hover)]',
                  )}
                >
                  <RotateCw size={14} aria-hidden />
                  {t('sidebar.dshConsoleRetry')}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
