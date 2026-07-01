/**
 * Audit Log / Activity Timeline — a read-only view over the hash-chained,
 * append-only audit_log. Every material change across RIOS is here with actor,
 * action and tamper-evident hashing. Gated on ops:read.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ShieldCheck, Sparkles, Fingerprint } from 'lucide-react';
import { api } from '../lib/api';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { titleCase } from '../lib/format';
import type { TokenColor } from '../lib/status';
import styles from './AuditLogPage.module.css';

interface Entry {
  id: string; occurredAt: string; actor: string | null; action: string;
  entityType: string; entityId: string | null; viaAssistant: boolean; tamperEvident: boolean;
}
interface Facet { key: string; n: number; }
interface AuditResp { entries: Entry[]; entityTypes: Facet[]; actions: Facet[]; chain: { total: number; hashed: number }; }

const ACTION_COLOR: Record<string, TokenColor> = {
  create: 'green', update: 'blue', delete: 'red', bind: 'violet', post: 'teal', confirm: 'indigo',
  transition: 'blue', price: 'violet', score: 'violet', refer: 'amber', approval_decision: 'amber',
  document_add: 'teal', document_sign: 'green', task_create: 'blue', task_status: 'blue',
};
const actionColor = (a: string): TokenColor => ACTION_COLOR[a] ?? 'slate';

export function AuditLogPage() {
  const [entityType, setEntityType] = useState('');
  const [action, setAction] = useState('');
  const q = useQuery({ queryKey: ['audit', entityType, action], queryFn: () => api<AuditResp>(`/api/audit?limit=200${entityType ? `&entityType=${entityType}` : ''}${action ? `&action=${action}` : ''}`) });
  const d = q.data;

  const columns: Column<Entry>[] = [
    { key: 'time', header: 'When', sortValue: (r) => r.occurredAt, render: (r) => <span className={styles.time}>{new Date(r.occurredAt).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span> },
    { key: 'action', header: 'Action', render: (r) => <Badge color={actionColor(r.action)}>{titleCase(r.action.replace(/_/g, ' '))}</Badge> },
    { key: 'entity', header: 'Entity', render: (r) => (<div><div className={styles.cellMain}>{titleCase(r.entityType.replace(/_/g, ' '))}</div>{r.entityId && <div className={styles.cellSub}>{r.entityId.slice(0, 8)}…</div>}</div>) },
    { key: 'actor', header: 'Actor', render: (r) => <span className={styles.cellSub}>{r.actor ?? 'system'}{r.viaAssistant && <span className={styles.aiChip}><Sparkles size={11} /> AI</span>}</span> },
    { key: 'hash', header: '', align: 'right', render: (r) => r.tamperEvident ? <span className={styles.hash} title="Hash-chained (tamper-evident)"><Fingerprint size={14} /></span> : null },
  ];

  return (
    <>
      <PageHeader
        title="Audit Log"
        description="Hash-chained, append-only activity timeline — every material change across RIOS, with actor and tamper-evidence."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Operations' }, { label: 'Audit Log' }]}
        actions={<Badge color="green"><ShieldCheck size={13} /> {d ? `${d.chain.hashed}/${d.chain.total} hash-chained` : 'Tamper-evident'}</Badge>}
      />

      <Card padded={false}>
        <CardHeader title="Activity timeline" subtitle="Most recent first" />
        <div className={styles.filters}>
          <div className={styles.filterGroup}>
            <span className={styles.filterLabel}>Entity</span>
            <button className={`${styles.chip} ${!entityType ? styles.chipActive : ''}`} onClick={() => setEntityType('')}>All</button>
            {(d?.entityTypes ?? []).slice(0, 10).map((f) => (
              <button key={f.key} className={`${styles.chip} ${entityType === f.key ? styles.chipActive : ''}`} onClick={() => setEntityType(f.key)}>{titleCase(f.key.replace(/_/g, ' '))} <span className={styles.chipN}>{f.n}</span></button>
            ))}
          </div>
          <div className={styles.filterGroup}>
            <span className={styles.filterLabel}>Action</span>
            <button className={`${styles.chip} ${!action ? styles.chipActive : ''}`} onClick={() => setAction('')}>All</button>
            {(d?.actions ?? []).slice(0, 10).map((f) => (
              <button key={f.key} className={`${styles.chip} ${action === f.key ? styles.chipActive : ''}`} onClick={() => setAction(f.key)}>{titleCase(f.key.replace(/_/g, ' '))} <span className={styles.chipN}>{f.n}</span></button>
            ))}
          </div>
        </div>
        <div className={styles.tableWrap}>
          <Table columns={columns} rows={d?.entries} loading={q.isLoading} rowKey={(r) => r.id}
            empty={<EmptyState icon={<ShieldCheck size={18} />} title="No activity" message="No audit entries match this filter." />}
            skeletonRows={8} />
        </div>
      </Card>
    </>
  );
}
