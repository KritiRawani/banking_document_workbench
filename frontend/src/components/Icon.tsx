import type { CSSProperties, ReactNode } from 'react';

export type IconName = 'bank' | 'upload' | 'file' | 'check' | 'sparkles' | 'arrow' | 'layers' | 'alert' | 'copy';

const paths: Record<IconName, ReactNode> = {
  bank: <><path d="m3 8 9-5 9 5M4 10h16M5 20h14M3 22h18M6 10v7m6-7v7m6-7v7" /></>,
  upload: <><path d="M12 16V4m-4 4 4-4 4 4M4 15v5h16v-5" /></>,
  file: <><path d="M14 3H6v18h12V7l-4-4Z" /><path d="M14 3v5h5M9 12h6m-6 4h6" /></>,
  check: <><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></>,
  sparkles: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z" /><path d="m20 2 .5 1.5L22 4l-1.5.5L20 6l-.5-1.5L18 4l1.5-.5L20 2Z" /></>,
  arrow: <><path d="M4 12h16m-6-6 6 6-6 6" /></>,
  layers: <><path d="m12 3 10 5-10 5L2 8l10-5Zm-9 10 9 5 9-5M3 18l9 5 9-5" /></>,
  alert: <><path d="m12 3 10 18H2L12 3Z" /><path d="M12 9v5m0 3h.01" /></>,
  copy: <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M15 8V3H3v13h5" /></>,
};

export default function Icon({ name, className = '', style }: { name: IconName; className?: string; style?: CSSProperties }) {
  return <svg className={`icon ${className}`} style={style} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
