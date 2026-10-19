import { useMemo } from 'react';
import { Icon } from '../common/Icons';
import { Tooltip } from '../common/Tooltip';
import { modKey } from '../platform';
import { appStore, useApp } from '../state/appStore';
import { tabLabels } from './tabs';
import { t } from '../../i18n';

export function TabBar() {
  const tabs = useApp((s) => s.tabs);
  const activeId = useApp((s) => s.activeId);
  const labels = useMemo(() => tabLabels(tabs), [tabs]);
  return (
    <div className="tab-bar" role="tablist" aria-label={t('tabs.aria')}>
      <span className="wordmark" aria-hidden="true">LANES</span>
      {tabs.map((tab, i) => {
        const active = tab.id === activeId;
        return (
          <div
            key={tab.id}
            className={'tab' + (active ? ' active' : '')}
            onMouseDown={(e) => {
              if (e.button === 1) { e.preventDefault(); appStore.requestCloseTab(tab.id); }
            }}
          >
            <Tooltip label={tab.path} shortcut={i < 9 ? modKey(String(i + 1)) : undefined}>
              <button
                className="tab-main"
                role="tab"
                aria-selected={active}
                aria-label={labels.get(tab.id) ?? tab.name}
                onClick={() => appStore.activate(tab.id)}
              >
                <Icon name="branch" size={12} />
                <span className="tab-label">{labels.get(tab.id) ?? tab.name}</span>
              </button>
            </Tooltip>
            <Tooltip label={t('tabs.close')} shortcut={active ? modKey('W') : undefined}>
              <button className="tab-close" onClick={() => appStore.requestCloseTab(tab.id)}>
                <Icon name="close" size={10} />
              </button>
            </Tooltip>
          </div>
        );
      })}
      <Tooltip label={t('common.openRepo')} shortcut={modKey('T')}>
        <button className="tab-add" onClick={() => void appStore.chooseAndOpenRepo()}>
          <Icon name="plus" size={13} />
        </button>
      </Tooltip>
    </div>
  );
}
