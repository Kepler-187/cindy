/**
 * useAutomationGroupCollapsed — 侧边栏「自动化任务分组」的展开/收起持久化。
 * ---------------------------------------------------------------------------
 * 这是「轴 1 = 文件夹开/关」:收起 = 把该组下的所有运行藏起来,只留组头一行。
 * 它和组内「轴 2 = 前 5 条 / 显示全部」是两个完全独立的东西 —— 这里只管 disclosure。
 *
 * 折叠状态是**用户的明确选择,永久持久化、不按时间过期**:
 * - owner-scoped localStorage key derived from `cc-agent.sidebar.collapsedAutomationGroups`
 * - 默认展开(storage 里没有该组 = 展开);仅持久化"已收起"的组
 * - **不做定时 GC** —— 收起就一直收起,直到用户再展开,绝不"用了一阵自己弹开"。
 *   删掉的定时任务会在本地留一条极小的孤儿记录(几十字节),量可忽略,不值得为清它引入
 *   "按时间删"从而误删活跃分组的风险(这正是早先 30 天 GC 会把活跃分组弹开的根因)。
 *
 * 每个分组组件订阅同一份 owner-scoped 存储投影。单组 toggle 与段头批量操作都走
 * "读-改-写",写完同步通知已挂载的组,避免批量收起只改 storage、画面不更新。
 */

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { createLogger } from '@/lib/logger';
import { readSidebarOwnerStorage, writeSidebarOwnerStorage } from '@/lib/sidebarOwnerStorage';

const log = createLogger('UseAutomationGroupCollapsed');

const STORAGE_KEY = 'cc-agent.sidebar.collapsedAutomationGroups';

interface StoredEntry {
  /** 只存"已收起"的组,展开的组从 stored 中删除。 */
  collapsed: true;
  /** ISO 8601 — 上次写入时间(仅留作排查/未来用,不参与任何过期判定)。 */
  lastSeenAt: string;
}

type Stored = Record<string, StoredEntry>;

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emitChange(): void {
  for (const listener of listeners) listener();
}

function loadStored(ownerId: string | null): Stored {
  try {
    const raw = readSidebarOwnerStorage(STORAGE_KEY, ownerId);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Stored = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (value && typeof value === 'object') {
          const entry = value as Partial<StoredEntry>;
          if (entry.collapsed === true && typeof entry.lastSeenAt === 'string') {
            out[key] = { collapsed: true, lastSeenAt: entry.lastSeenAt };
          }
        }
      }
      return out;
    }
    return {};
  } catch (err) {
    // JSON parse / localStorage 异常(含 node 测试环境无 localStorage)→ 静默回退
    log.warn('failed to load stored state:', err);
    return {};
  }
}

function writeStored(next: Stored, ownerId: string | null): void {
  if (!writeSidebarOwnerStorage(STORAGE_KEY, ownerId, JSON.stringify(next))) {
    log.warn('failed to write stored state');
  }
}

/** 读取某个分组当前是否收起(默认 false = 展开)。 */
export function isAutomationGroupCollapsed(groupKey: string, ownerId: string | null): boolean {
  return Boolean(loadStored(ownerId)[groupKey]);
}

/** 写入某个分组的收起态:收起则记一条条目,展开则删除该 key(默认值跟随版本)。 */
export function setAutomationGroupCollapsed(
  groupKey: string,
  collapsed: boolean,
  ownerId: string | null,
): void {
  setAutomationGroupsCollapsed([groupKey], collapsed, ownerId);
}

/** 批量写入可见自动任务组的收起态,只落一次 storage 并统一唤醒已挂载组。 */
export function setAutomationGroupsCollapsed(
  groupKeys: readonly string[],
  collapsed: boolean,
  ownerId: string | null,
): void {
  const stored = loadStored(ownerId);
  const lastSeenAt = new Date().toISOString();
  let changed = false;
  for (const groupKey of groupKeys) {
    const wasCollapsed = Boolean(stored[groupKey]);
    if (wasCollapsed === collapsed) continue;
    changed = true;
    if (collapsed) {
      stored[groupKey] = { collapsed: true, lastSeenAt };
    } else {
      delete stored[groupKey];
    }
  }
  if (!changed) return;
  writeStored(stored, ownerId);
  emitChange();
}

/**
 * 组件侧 hook:返回 [collapsed, toggle]。collapsed 由 localStorage 初始化(默认展开),
 * 并在 owner / group 边界变化时重新绑定；toggle 只写入创建它时对应的当前 binding。
 */
export function useAutomationGroupCollapsed(groupKey: string): readonly [boolean, () => void] {
  const { dataOwnerId: ownerId, generation: ownerGeneration } = getDataOwnerGeneration();
  const [collapsed, setCollapsedState] = useState(() =>
    isAutomationGroupCollapsed(groupKey, ownerId),
  );
  const committedBindingRef = useRef({ groupKey, ownerId });

  // AuthContext 先同步发布 data owner，再触发 React 重渲染。layout effect 在浏览器绘制前
  // 装载新 binding，避免短暂展示上一账号或上一分组的折叠态。
  useLayoutEffect(() => {
    committedBindingRef.current = { groupKey, ownerId };
    const ownerAtEffect = { dataOwnerId: ownerId, generation: ownerGeneration };
    const syncFromStorage = () => {
      const committedBinding = committedBindingRef.current;
      if (
        committedBinding.groupKey !== groupKey ||
        committedBinding.ownerId !== ownerId ||
        !isDataOwnerGenerationCurrent(ownerAtEffect)
      ) {
        return;
      }
      setCollapsedState(isAutomationGroupCollapsed(groupKey, ownerId));
    };
    syncFromStorage();
    return subscribe(syncFromStorage);
  }, [groupKey, ownerGeneration, ownerId]);

  const toggle = useCallback(() => {
    const ownerAtRender = { dataOwnerId: ownerId, generation: ownerGeneration };
    const isCurrentBinding = (): boolean => {
      const currentBinding = committedBindingRef.current;
      return (
        currentBinding.groupKey === groupKey &&
        currentBinding.ownerId === ownerId &&
        isDataOwnerGenerationCurrent(ownerAtRender)
      );
    };
    // Owner generation is published synchronously before React rerenders. Reject an old callback
    // even during that boundary window. Storage is the source of truth; its change notification
    // synchronizes every mounted instance of this group.
    if (!isCurrentBinding()) return;
    setAutomationGroupCollapsed(
      groupKey,
      !isAutomationGroupCollapsed(groupKey, ownerId),
      ownerId,
    );
  }, [groupKey, ownerGeneration, ownerId]);
  return [collapsed, toggle] as const;
}

/** 段头批量折叠所需的聚合状态与写入口。空集合视为已收起,便于与其它组层合取。 */
export function useAutomationGroupsCollapsed(
  groupKeys: readonly string[],
): readonly [boolean, (collapsed: boolean) => void] {
  const { dataOwnerId: ownerId, generation: ownerGeneration } = getDataOwnerGeneration();
  const [, setRevision] = useState(0);

  useLayoutEffect(() => {
    const ownerAtEffect = { dataOwnerId: ownerId, generation: ownerGeneration };
    return subscribe(() => {
      if (!isDataOwnerGenerationCurrent(ownerAtEffect)) return;
      setRevision((revision) => revision + 1);
    });
  }, [ownerGeneration, ownerId]);

  const allCollapsed = groupKeys.every((groupKey) =>
    isAutomationGroupCollapsed(groupKey, ownerId),
  );
  const setAllCollapsed = useCallback(
    (collapsed: boolean) => {
      const ownerAtRender = { dataOwnerId: ownerId, generation: ownerGeneration };
      if (!isDataOwnerGenerationCurrent(ownerAtRender)) return;
      setAutomationGroupsCollapsed(groupKeys, collapsed, ownerId);
    },
    [groupKeys, ownerGeneration, ownerId],
  );
  return [allCollapsed, setAllCollapsed] as const;
}
