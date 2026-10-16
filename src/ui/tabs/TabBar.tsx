import { useMemo } from 'react';
import { Icon } from '../common/Icons';
import { Tooltip } from '../common/Tooltip';
import { modKey } from '../platform';
import { appStore, useApp } from '../state/appStore';
import { tabLabels } from './tabs';

export function TabBar() {
  const tabs = useApp((s) => s.tabs);
  const activeId = useApp((s) => s.activeId);
  const labels = useMemo(() => tabLabels(tabs), [tabs]);
  return (
    <div className="tab-bar" role="tablist" aria-label="열린 저장소">
      <span className="wordmark" aria-hidden="true">LANES</span>
      {tabs.map((t, i) => {
        const active = t.id === activeId;
        return (
          <div
            key={t.id}
            className={'tab' + (active ? ' active' : '')}
            onMouseDown={(e) => {
              if (e.button === 1) { e.preventDefault(); appStore.closeTab(t.id); }
            }}
          >
            <Tooltip label={t.path} shortcut={i < 9 ? modKey(String(i + 1)) : undefined}>
              <button
                className="tab-main"
                role="tab"
                aria-selected={active}
                aria-label={labels.get(t.id) ?? t.name}
                onClick={() => appStore.activate(t.id)}
              >
                <Icon name="branch" size={12} />
                <span className="tab-label">{labels.get(t.id) ?? t.name}</span>
              </button>
            </Tooltip>
            <Tooltip label="탭 닫기" shortcut={active ? modKey('W') : undefined}>
              <button className="tab-close" onClick={() => appStore.closeTab(t.id)}>
                <Icon name="close" size={10} />
              </button>
            </Tooltip>
          </div>
        );
      })}
      <Tooltip label="저장소 열기…" shortcut={modKey('T')}>
        <button className="tab-add" onClick={() => void appStore.chooseAndOpenRepo()}>
          <Icon name="plus" size={13} />
        </button>
      </Tooltip>
    </div>
  );
}
