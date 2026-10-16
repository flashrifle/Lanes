import type { ReactNode } from 'react';

export type IconName =
  | 'chevronRight' | 'chevronDown' | 'plus' | 'close' | 'refresh' | 'download' | 'star' | 'starOutline'
  | 'collapse' | 'expand' | 'folder' | 'tag' | 'branch' | 'search' | 'check' | 'warning' | 'sort' | 'pull' | 'head' | 'lock';

const paths: Record<IconName, ReactNode> = {
  chevronRight: <path d="M6 4l4 4-4 4" />,
  chevronDown: <path d="M4 6l4 4 4-4" />,
  plus: <path d="M8 3v10M3 8h10" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  refresh: <path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3" />,
  download: <path d="M8 2.5v7.5M4.8 7.2L8 10.4l3.2-3.2M3 13h10" />,
  pull: <path d="M8 2.5v7M4.8 7.2L8 10.4l3.2-3.2M3 13h10M3 2.5h10" />,
  star: <path fill="currentColor" d="M8 2l1.9 4 4.4.5-3.3 3 .9 4.4L8 11.7 4.1 13.9 5 9.5l-3.3-3L6.1 6z" />,
  starOutline: <path d="M8 2l1.9 4 4.4.5-3.3 3 .9 4.4L8 11.7 4.1 13.9 5 9.5l-3.3-3L6.1 6z" />,
  collapse: <path d="M4 6l4-3 4 3M4 10l4 3 4-3" />,
  expand: <path d="M4 5l4 3 4-3M4 11l4-3 4 3" />,
  folder: <path d="M2 4.5h4l1.5 1.5H14v6.5H2z" />,
  tag: <><path d="M2 8.5V2.5h6l6 6-5.5 5.5z" /><circle cx="5.2" cy="5.2" r="0.8" fill="currentColor" /></>,
  branch: <><circle cx="5" cy="3.5" r="1.5" /><circle cx="5" cy="12.5" r="1.5" /><circle cx="11" cy="6" r="1.5" /><path d="M5 5v6M11 7.5c0 2.5-6 1-6 3" /></>,
  search: <><circle cx="7" cy="7" r="4" /><path d="M10 10l3.5 3.5" /></>,
  check: <path d="M3.5 8.5l3 3 6-7" />,
  warning: <path d="M8 2.5l6 10.5H2zM8 7v3M8 11.5v.5" />,
  sort: <path d="M5 3v10M2.5 10.5L5 13l2.5-2.5M11 13V3M8.5 5.5L11 3l2.5 2.5" />,
  head: <path d="M3 8h10M9 4l4 4-4 4" />,
  lock: <><rect x="3.5" y="7" width="9" height="6" rx="1" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></>,
};

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {paths[name]}
    </svg>
  );
}

const FILE_BADGES: Record<string, { text: string; color: string }> = {
  ts: { text: 'TS', color: '#3178C6' }, tsx: { text: 'TS', color: '#3178C6' },
  js: { text: 'JS', color: '#C9A227' }, jsx: { text: 'JS', color: '#C9A227' }, mjs: { text: 'JS', color: '#C9A227' },
  json: { text: '{}', color: '#8A8F98' }, css: { text: '#', color: '#9B59B6' }, scss: { text: '#', color: '#CC6699' },
  html: { text: '<>', color: '#E44D26' }, md: { text: 'M', color: '#6F737A' }, rs: { text: 'RS', color: '#C0623B' },
  toml: { text: 'T', color: '#8A8F98' }, yml: { text: 'Y', color: '#8A8F98' }, yaml: { text: 'Y', color: '#8A8F98' },
  py: { text: 'PY', color: '#3C78AA' }, go: { text: 'GO', color: '#00ADD8' }, java: { text: 'J', color: '#D9822B' },
  kt: { text: 'K', color: '#A97BFF' }, svg: { text: 'SV', color: '#E8A33D' }, sh: { text: '$', color: '#5FB878' },
};

export function FileIcon({ ext, size = 16 }: { ext: string; size?: number }) {
  const b = FILE_BADGES[ext];
  return (
    <span className="file-icon" style={{ width: size, height: size, background: b ? b.color : '#4E5157' }} aria-hidden>
      {b ? b.text : ''}
    </span>
  );
}
