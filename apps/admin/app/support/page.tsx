'use client';
/**
 * Support inbox (build plan P12b, Bible 2.8 L40): one conversation per merchant, newest first,
 * unread counts; replies go to the merchant app live. Screen share from the register waits for the
 * device-management vendor decision (⛔).
 */
import type { ServerMessage, SupportConversation, SupportMessage } from '@adpay/shared';
import { useEffect, useRef, useState } from 'react';
import { useRealtime } from '../../components/realtime';
import { ErrorBox, Shell, useLoad } from '../../components/ui';
import { api } from '../../lib/api';

export default function SupportPage() {
  const inbox = useLoad(() => api<{ conversations: SupportConversation[] }>('/admin/support'), []);
  const [open, setOpen] = useState<string | null>(null);
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<unknown>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    api<{ messages: SupportMessage[] }>(`/admin/support/${open}`).then((r) => {
      setMessages(r.messages);
      inbox.reload();
    }, setError);
  }, [open]);
  useEffect(() => end.current?.scrollIntoView({ behavior: 'smooth' }), [messages.length]);

  useRealtime((m: ServerMessage) => {
    if (m.type !== 'support') return;
    if (m.message.merchant_id === open) setMessages((prev) => (prev.some((x) => x.message_id === m.message.message_id) ? prev : [...prev, m.message]));
    inbox.reload();
  });

  async function send() {
    if (!open || !draft.trim()) return;
    setError(null);
    try {
      const m = await api<SupportMessage>(`/admin/support/${open}`, { method: 'POST', body: { body: draft.trim() } });
      setMessages((prev) => (prev.some((x) => x.message_id === m.message_id) ? prev : [...prev, m]));
      setDraft('');
    } catch (e) {
      setError(e);
    }
  }

  const convo = inbox.data?.conversations.find((c) => c.merchant_id === open);

  return (
    <Shell>
      <h1>Support</h1>
      <ErrorBox error={inbox.error ?? error} />
      <div className="support">
        <div className="panel support-list">
          {inbox.data?.conversations.length === 0 && <p className="muted">No messages yet. Merchants write from the Help tab in their app.</p>}
          {inbox.data?.conversations.map((c) => (
            <button key={c.merchant_id} className={`support-row ${open === c.merchant_id ? 'active' : ''}`} onClick={() => setOpen(c.merchant_id)}>
              <strong>{c.merchant_name}</strong> {c.unread > 0 && <span className="pill warn">{c.unread} new</span>}
              <div className="tiny muted">{c.last_message.body.slice(0, 80)}</div>
            </button>
          ))}
        </div>
        <div className="panel support-thread">
          {!open ? (
            <p className="muted">Pick a conversation.</p>
          ) : (
            <>
              <h2>{convo?.merchant_name ?? 'Conversation'}</h2>
              <div className="support-messages">
                {messages.map((m) => (
                  <div key={m.message_id} className={`support-msg ${m.author_kind === 'admin' ? 'mine' : ''}`}>
                    <div>{m.body}</div>
                    <div className="tiny muted">
                      {m.author_name ?? (m.author_kind === 'admin' ? 'AD Pay' : 'Merchant')} · {new Date(m.created_at).toLocaleString()}
                    </div>
                  </div>
                ))}
                <div ref={end} />
              </div>
              <div className="inline">
                <textarea
                  rows={2}
                  style={{ flex: 1 }}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  maxLength={2000}
                  placeholder="Reply (Enter to send, Shift+Enter for a new line)"
                />
                <button className="primary" disabled={!draft.trim()} onClick={() => void send()}>
                  Send
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </Shell>
  );
}
