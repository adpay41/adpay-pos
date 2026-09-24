import { cents, formatUsd } from '@adpay/shared';

/** Brand: red / black / white; green only for approved / money-received. Never red near an amount. */
export const C = { red: '#c8102e', black: '#111', ink: '#1d1d1d', muted: '#6b6b6b', line: '#e4e4e4', ground: '#f6f6f6', green: '#0a7f3f' };

/** Money is formatted only at the edge. */
export const usd = (v: number) => formatUsd(cents(v));

/** Integer cents → editable dollars text ("2.49"), no float math. */
export const dollars = (c: number | null) => (c === null ? '' : formatUsd(cents(c)).replace('$', '').replace(/,/g, ''));
