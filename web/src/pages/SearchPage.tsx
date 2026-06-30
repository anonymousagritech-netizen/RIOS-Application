/**
 * Global search (brief §11.3). A single box that queries the cross-entity
 * /api/search surface and groups the hits by type, each linking to its detail
 * view. Results already respect per-entity RBAC server-side.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, qs } from '../lib/api';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { Badge } from '../components/Badge';
import { TextField } from '../components/Form';
import { Spinner } from '../components/Feedback';
import { EmptyState } from '../components/Table';
import { titleCase } from '../lib/format';
import shared from './shared.module.css';

interface Hit { type: string; id: string; label: string; sublabel?: string | null; ref?: string | null; url: string }
interface SearchResponse { query: string; results: Hit[]; groups: { type: string; hits: Hit[] }[] }

const TYPE_COLOR: Record<string, 'blue' | 'violet' | 'amber' | 'teal' | 'slate'> = {
  party: 'blue', contract: 'violet', claim: 'amber', statement: 'teal',
};

export function SearchPage() {
  const [term, setTerm] = useState('');
  const q = useQuery({
    queryKey: ['global-search', term],
    queryFn: () => api<SearchResponse>(`/api/search${qs({ q: term })}`),
    enabled: term.trim().length >= 2,
  });

  return (
    <>
      <PageHeader title="Search" description="Find parties, contracts, claims and statements across the platform." />
      <Card>
        <div style={{ padding: 'var(--space-5)', display: 'grid', gap: 'var(--space-4)' }}>
          <TextField label="Search" value={term} onChange={setTerm} placeholder="Type at least two characters…" />
          {q.isFetching && <Spinner />}
          {term.trim().length >= 2 && !q.isFetching && q.data && q.data.results.length === 0 && (
            <EmptyState title="No matches" message={`Nothing found for “${term}”.`} />
          )}
        </div>
      </Card>

      {q.data?.groups.map((g) => (
        <Card key={g.type}>
          <CardHeader
            title={titleCase(g.type)}
            actions={<Badge color={TYPE_COLOR[g.type] ?? 'slate'}>{g.hits.length}</Badge>}
          />
          <div style={{ padding: 'var(--space-2) var(--space-4) var(--space-4)' }}>
            {g.hits.map((h) => (
              <Link key={`${h.type}:${h.id}`} to={h.url} style={{ textDecoration: 'none' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 'var(--space-3) 0', borderBottom: '1px solid var(--border)' }}>
                  <div>
                    <div className={shared.cellMain}>{h.label}</div>
                    {h.sublabel && <div className={shared.cellSub}>{h.sublabel}</div>}
                  </div>
                  {h.ref && <span className={shared.cellRef}>{h.ref}</span>}
                </div>
              </Link>
            ))}
          </div>
        </Card>
      ))}
    </>
  );
}
