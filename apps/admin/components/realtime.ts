'use client';
/**
 * Live updates for admin pages over the API's `/ws` channel (P4). The first message authenticates
 * (the token never goes in the URL). Reconnects with backoff; pages still work, just not live, if
 * the socket can't connect.
 */
import type { ServerMessage } from '@adpay/shared';
import { useEffect, useRef } from 'react';
import { API_URL, getToken } from '../lib/api';

export function useRealtime(onMessage: (m: ServerMessage) => void): void {
  const handler = useRef(onMessage);
  useEffect(() => {
    handler.current = onMessage;
  });
  useEffect(() => {
    let ws: WebSocket | null = null;
    let stopped = false;
    let backoff = 1_000;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      const token = getToken();
      if (!token || stopped) return;
      ws = new WebSocket(`${API_URL.replace(/^http/, 'ws')}/ws`);
      ws.onopen = () => ws?.send(JSON.stringify({ type: 'auth', token }));
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(String(ev.data)) as ServerMessage;
          if (m.type === 'ready') backoff = 1_000;
          handler.current(m);
        } catch {
          /* ignore malformed frames */
        }
      };
      ws.onclose = () => {
        if (stopped) return;
        timer = setTimeout(connect, backoff);
        backoff = Math.min(30_000, backoff * 2);
      };
    };
    connect();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, []);
}
