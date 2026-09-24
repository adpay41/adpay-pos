import { cents, formatUsd } from '@adpay/shared';

/** Brand: red / black / white; green only for approved / money-received. Never red near an amount. */
export const C = {
  red: '#c8102e',
  black: '#111',
  ink: '#1d1d1d',
  muted: '#6b6b6b',
  line: '#e4e4e4',
  ground: '#f2f2f2',
  green: '#0a7f3f',
  greenBg: '#e7f5ec',
  amber: '#8a5300',
  amberBg: '#fff4e5',
};

/** Display-only formatting of integer cents. */
export const usd = (v: number) => formatUsd(cents(v));
