'use client';
import { ErrorBox, Shell, When, useLoad } from '../../components/ui';
import { api } from '../../lib/api';

interface Entry {
  audit_id: string;
  at: string;
  actor_kind: string;
  actor_email: string | null;
  action: string;
  target: string | null;
  details: Record<string, unknown>;
  trace_id: string;
}

export default function AuditPage() {
  const { data, error } = useLoad(() => api<{ entries: Entry[] }>('/admin/audit?limit=200'), []);
  return (
    <Shell>
      <h1>Audit log</h1>
      <p className="muted">Append-only. Every admin action and every login attempt lands here.</p>
      <ErrorBox error={error} />
      <div className="panel table-wrap">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>Action</th>
              <th>Target</th>
              <th>Trace</th>
            </tr>
          </thead>
          <tbody>
            {data?.entries.map((e) => (
              <tr key={e.audit_id}>
                <td>
                  <When at={e.at} />
                </td>
                <td>{e.actor_email ?? e.actor_kind}</td>
                <td>
                  <strong>{e.action}</strong>
                </td>
                <td className="mono">{e.target}</td>
                <td className="mono muted">{e.trace_id.slice(0, 12)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
