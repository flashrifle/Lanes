/** Transit-line palette: vivid on the dark Metro background; neighbouring indices differ in hue. */
export const GRAPH_PALETTE = [
  '#2F78FF', '#B04CF0', '#2FD47A', '#FF9A2E', '#FF4F9A', '#1FD1E0', '#F5D33B', '#F2554D',
  '#14B8A6', '#7C6CFF', '#A3E635', '#FF7A59', '#5BA8FF', '#D946EF', '#6EE7B7', '#FF8FA3',
];
export const colorOf = (i: number): string => GRAPH_PALETTE[((i % 16) + 16) % 16];
export const MUTED_LINE = '#3A4157';

function lum(hex: string): number {
  const c = [1, 3, 5].map((o) => {
    const v = parseInt(hex.slice(o, o + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const contrast = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
const shade = (hex: string, f: number): string =>
  '#' + [1, 3, 5].map((o) => Math.round(parseInt(hex.slice(o, o + 2), 16) * f).toString(16).padStart(2, '0')).join('');

const INK_DARK = '#0B0D12';
export interface BadgeColors { bg: string; ink: string }
const badgeCache = GRAPH_PALETTE.map((hex): BadgeColors => {
  for (const f of [1, 0.85]) {
    const bg = f === 1 ? hex : shade(hex, f);
    if (contrast(1, lum(bg)) >= 4.5) return { bg, ink: '#fff' };
  }
  return { bg: hex, ink: INK_DARK };
});
/** Badge background + readable text colour (>= 4.5:1) for line colour index `i`. */
export const badgeOf = (i: number): BadgeColors => badgeCache[((i % 16) + 16) % 16];
