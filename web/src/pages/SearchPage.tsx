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
import { Spinner } from '../components/Feedback';
import { EmptyState } from '../components/Table';
import { titleCase } from '../lib/format';
import {
  Search as SearchIcon, Building2, FileText, AlertTriangle, ReceiptText, CircleDot, ArrowUpRight,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import styles from './SearchPage.module.css';

interface Hit { type: string; id: string; label: string; sublabel?: string | null; ref?: string | null; url: string }
interface SearchResponse { query: string; results: Hit[]; groups: { type: string; hits: Hit[] }[] }

const TYPE_COLOR: Record<string, 'blue' | 'violet' | 'amber' | 'teal' | 'slate'> = {
  party: 'blue', contract: 'violet', claim: 'amber', statement: 'teal',
};

const TYPE_META: Record<string, { icon: LucideIcon; accent: string }> = {
  party: { icon: Building2, accent: 'var(--accent-blue)' },
  contract: { icon: FileText, accent: 'var(--accent-violet)' },
  claim: { icon: AlertTriangle, accent: 'var(--accent-orange)' },
  statement: { icon: ReceiptText, accent: 'var(--accent-cyan)' },
};

export function SearchPage() {
  const [term, setTerm] = useState('');
  const ready = term.trim().length >= 2;
  const q = useQuery({
    queryKey: ['global-search', term],
    queryFn: () => api<SearchResponse>(`/api/search${qs({ q: term })}`),
    enabled: ready,
  });

  const total = q.data?.results.length ?? 0;
  const noMatches = ready && !q.isFetching && q.data && total === 0;

  return (
    <>
      <PageHeader
        title="Search"
        description="Find parties, contracts, claims and statements across the platform."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Search' }]}
      />

      <div className={styles.hero}>
        <div>
          <h2 className={styles.heroTitle}>Search everything</h2>
          <p className={styles.heroSub}>One box across parties, contracts, claims and statements - results respect your permissions.</p>
        </div>
        <div className={styles.searchBox}>
          <SearchIcon size={20} className={styles.searchIcon} aria-hidden />
          <input
            className={styles.searchInput}
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Type at least two characters…"
            aria-label="Search"
            autoFocus
          />
          {q.isFetching && <span className={styles.spin}><Spinner /></span>}
        </div>
      </div>

      {ready && total > 0 && (
        <div className={styles.summary}>
          <Badge color="blue">{total} result{total === 1 ? '' : 's'}</Badge>
          <span className={styles.summaryText}>for “{term}”</span>
        </div>
      )}

      {!ready && (
        <Card>
          <div className={styles.emptyWrap}>
            <EmptyState
              icon={<SearchIcon size={20} />}
              title="Start typing to search"
              message="Look up a party, contract, claim or statement by name or reference. Enter at least two characters to begin."
            />
          </div>
        </Card>
      )}

      {noMatches && (
        <Card>
          <div className={styles.emptyWrap}>
            <EmptyState icon={<SearchIcon size={20} />} title="No matches" message={`Nothing found for “${term}”. Try a different name or reference.`} />
          </div>
        </Card>
      )}

      <div className={styles.results}>
        {q.data?.groups.map((g) => {
          const meta = TYPE_META[g.type];
          const Icon = meta?.icon ?? CircleDot;
          return (
            <Card key={g.type} padded={false}>
              <CardHeader
                title={titleCase(g.type)}
                subtitle={`${g.hits.length} match${g.hits.length === 1 ? '' : 'es'}`}
                actions={<Badge color={TYPE_COLOR[g.type] ?? 'slate'}>{g.hits.length}</Badge>}
              />
              <div className={styles.hitList}>
                {g.hits.map((h) => (
                  <Link key={`${h.type}:${h.id}`} to={h.url} className={styles.hit}>
                    <span className={styles.hitIcon} style={{ color: meta?.accent ?? 'var(--primary)' }} aria-hidden>
                      <Icon size={18} />
                    </span>
                    <span className={styles.hitBody}>
                      <span className={styles.hitLabel}>{h.label}</span>
                      {h.sublabel && <span className={styles.hitSub}>{h.sublabel}</span>}
                    </span>
                    {h.ref && <span className={styles.hitRef}>{h.ref}</span>}
                    <ArrowUpRight size={16} aria-hidden style={{ color: 'var(--text-faint)' }} />
                  </Link>
                ))}
              </div>
            </Card>
          );
        })}
      </div>
    </>
  );
}
