'use client';
/**
 * A store's documents vault, read-only for support (P24b): what's on file and when it expires.
 * Opening a file is audited on the API — these are the store's papers.
 */
import { DOCUMENT_KINDS, expiryStatus, type DocumentKind } from '@adpay/shared';
import { useState } from 'react';
import { api, openFile } from '../lib/api';
import { ErrorBox, useLoad } from './ui';

interface Doc {
  document_id: string;
  kind: DocumentKind;
  title: string;
  location_name: string | null;
  expires_on: string | null;
  created_at: string;
}

export function DocumentsPanel({ merchantId }: { merchantId: string }) {
  const docs = useLoad(() => api<{ documents: Doc[] }>(`/admin/merchants/${merchantId}/documents`), [merchantId]);
  const [error, setError] = useState<unknown>(null);
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="panel">
      <h2>Documents</h2>
      <ErrorBox error={error ?? docs.error} />
      {docs.data?.documents.length === 0 ? <p className="muted">Nothing on file yet. The store uploads from the merchant app → Help → Documents.</p> : null}
      {docs.data?.documents.map((d) => {
        const st = expiryStatus(d.expires_on, today);
        return (
          <div key={d.document_id} style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '4px 0' }}>
            <button onClick={() => void openFile(`/admin/documents/${d.document_id}/file`).catch(setError)}>Open</button>
            <span>
              {d.title}{' '}
              <span className="tiny muted">
                · {DOCUMENT_KINDS[d.kind]}
                {d.location_name ? ` · ${d.location_name}` : ''}
              </span>
            </span>
            {d.expires_on ? <span className={`pill ${st === 'expired' ? 'bad' : st === 'soon' ? 'warn' : ''}`}>{st === 'expired' ? `expired ${d.expires_on}` : `expires ${d.expires_on}`}</span> : null}
          </div>
        );
      })}
    </div>
  );
}
