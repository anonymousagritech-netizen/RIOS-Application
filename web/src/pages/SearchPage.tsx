/**
 * Global search (brief §11.3). An enterprise search experience over the
 * cross-entity /api/search surface: keyword and natural-language modes,
 * type-ahead suggestions, saved searches and recent history. Hits are grouped
 * by type, each linking to its detail view, and results respect per-entity
 * RBAC server-side.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qs, ApiError } from '../lib/api';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Spinner } from '../components/Feedback';
import { EmptyState } from '../components/Table';
import { Modal } from '../components/Modal';
import { TextField } from '../components/Form';
import { titleCase } from '../lib/format';
import type { TokenColor } from '../lib/status';
import {
  Search as SearchIcon, Building2, FileText, AlertTriangle, ReceiptText, CircleDot,
  ArrowUpRight, Sparkles, Type, Bookmark, History, Save, X, Clock,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import styles from './SearchPage.module.css';

/* ---------------- Types (mirror the /api/search contracts) ---------------- */
interface Hit { type: string; id: string; label: string; sublabel?: string | null; ref?: string | null; url: string }
interface Group { type: string; hits: Hit[] }

interface SearchResponse { query: string; results: Hit[]; groups: Group[] }

interface NlParsed { terms: string[]; types: string[]; status: string | null; year: number | null; raw: string }
interface NlResponse { interpreted: string; parsed: NlParsed; groups: Group[]; results: Hit[] }

interface SuggestResponse { suggestions: string[] }

interface SavedSearch { id: string; name: string; query: string; filters: Record<string, unknown>; createdAt: string }
interface SavedResponse { saved: SavedSearch[] }

interface HistoryEntry { query: string; resultsCount: number; at: string }
interface HistoryResponse { history: HistoryEntry[] }

type Mode = 'keyword' | 'nl';

/* ---------------- Presentation constants ---------------- */
const TYPE_COLOR: Record<string, TokenColor> = {
  party: 'blue', contract: 'violet', claim: 'amber', statement: 'teal',
};
const TYPE_META: Record<string, { icon: LucideIcon; accent: string }> = {
  party: { icon: Building2, accent: 'var(--accent-blue)' },
  contract: { icon: FileText, accent: 'var(--accent-violet)' },
  claim: { icon: AlertTriangle, accent: 'var(--accent-orange)' },
  statement: { icon: ReceiptText, accent: 'var(--accent-cyan)' },
};

/** Debounce a fast-changing value so we don't fire a request per keystroke. */
function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

export function SearchPage() {
  const toast = useToast();
  const qc = useQueryClient();

  const [term, setTerm] = useState('');
  const [mode, setMode] = useState<Mode>('keyword');
  const [showSuggest, setShowSuggest] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  const debounced = useDebounced(term.trim(), 300);
  const ready = debounced.length >= 2;

  /* ---------- Keyword search (existing surface) ---------- */
  const keyword = useQuery({
    queryKey: ['global-search', debounced],
    queryFn: () => api<SearchResponse>(`/api/search${qs({ q: debounced })}`),
    enabled: ready && mode === 'keyword',
  });

  /* ---------- Natural-language search ---------- */
  const nl = useQuery({
    queryKey: ['global-search-nl', debounced],
    queryFn: () => api<NlResponse>(`/api/search/nl${qs({ q: debounced })}`),
    enabled: ready && mode === 'nl',
  });

  const active = mode === 'nl' ? nl : keyword;
  const groups: Group[] = active.data?.groups ?? [];
  const results: Hit[] = active.data?.results ?? [];
  const total = results.length;
  const isFetching = active.isFetching;
  const noMatches = ready && !isFetching && active.data != null && total === 0;
  const interpreted = mode === 'nl' ? nl.data?.interpreted : undefined;
  const parsed = mode === 'nl' ? nl.data?.parsed : undefined;

  /* ---------- Type-ahead suggestions ---------- */
  const suggestTerm = useDebounced(term.trim(), 150);
  const suggest = useQuery({
    queryKey: ['search-suggest', suggestTerm],
    queryFn: () => api<SuggestResponse>(`/api/search/suggest${qs({ q: suggestTerm })}`),
    enabled: suggestTerm.length >= 1,
  });
  const suggestions = suggest.data?.suggestions ?? [];

  /* ---------- Saved searches + history ---------- */
  const saved = useQuery({
    queryKey: ['saved-searches'],
    queryFn: () => api<SavedResponse>('/api/search/saved'),
  });
  const history = useQuery({
    queryKey: ['search-history'],
    queryFn: () => api<HistoryResponse>('/api/search/history'),
  });

  const deleteSaved = useMutation({
    mutationFn: (id: string) => api(`/api/search/saved/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['saved-searches'] });
      toast.success('Saved search removed');
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not delete saved search.'),
  });

  const createSaved = useMutation({
    mutationFn: (body: { name: string; query: string; filters: Record<string, unknown> }) =>
      api<{ id: string }>('/api/search/saved', { body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['saved-searches'] });
      toast.success('Search saved');
      setSaveOpen(false);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not save search.'),
  });

  /* ---------- Record history after a successful non-empty search ---------- */
  const lastLogged = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || isFetching || active.data == null) return;
    const key = `${mode}:${debounced}`;
    if (lastLogged.current === key) return;
    lastLogged.current = key;
    api('/api/search/history', { body: { query: debounced, resultsCount: total } })
      .then(() => {
        qc.invalidateQueries({ queryKey: ['search-history'] });
        qc.invalidateQueries({ queryKey: ['search-suggest'] });
      })
      .catch(() => { /* fire-and-forget: never block the UI on history */ });
  }, [ready, isFetching, active.data, mode, debounced, total, qc]);

  /* ---------- Interactions ---------- */
  const runQuery = (q: string) => {
    setTerm(q);
    setShowSuggest(false);
  };

  // Close the suggestion dropdown when clicking outside the search box.
  useEffect(() => {
    if (!showSuggest) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setShowSuggest(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [showSuggest]);

  const showSuggestList = showSuggest && term.trim().length >= 1 && suggestions.length > 0;
  const canSave = term.trim().length >= 2;

  const recent = useMemo(() => {
    const seen = new Set<string>();
    const out: HistoryEntry[] = [];
    for (const h of history.data?.history ?? []) {
      const k = h.query.trim().toLowerCase();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(h);
      if (out.length >= 8) break;
    }
    return out;
  }, [history.data]);

  return (
    <>
      <PageHeader
        title="Search"
        description="Find parties, contracts, claims and statements across the platform - by keyword or plain English."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Search' }]}
      />

      <div className={styles.hero}>
        <div className={styles.heroHead}>
          <div>
            <h2 className={styles.heroTitle}>Search everything</h2>
            <p className={styles.heroSub}>One box across parties, contracts, claims and statements - results respect your permissions.</p>
          </div>
          <div className={styles.modeToggle} role="tablist" aria-label="Search mode">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'keyword'}
              className={`${styles.modeChip} ${mode === 'keyword' ? styles.modeActive : ''}`}
              onClick={() => setMode('keyword')}
            >
              <Type size={14} aria-hidden /> Keyword
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'nl'}
              className={`${styles.modeChip} ${mode === 'nl' ? styles.modeActive : ''}`}
              onClick={() => setMode('nl')}
            >
              <Sparkles size={14} aria-hidden /> Natural language
            </button>
          </div>
        </div>

        <div className={styles.searchWrap} ref={boxRef}>
          <div className={styles.searchBox}>
            <SearchIcon size={20} className={styles.searchIcon} aria-hidden />
            <input
              className={styles.searchInput}
              value={term}
              onChange={(e) => { setTerm(e.target.value); setShowSuggest(true); }}
              onFocus={() => setShowSuggest(true)}
              placeholder={mode === 'nl' ? 'e.g. bound treaties in 2026' : 'Type at least two characters…'}
              aria-label="Search"
              autoFocus
            />
            {isFetching && <span className={styles.spin}><Spinner /></span>}
          </div>

          {showSuggestList && (
            <ul className={styles.suggestList} role="listbox" aria-label="Suggestions">
              {suggestions.map((s) => (
                <li key={s}>
                  <button
                    type="button"
                    className={styles.suggestItem}
                    onMouseDown={(e) => { e.preventDefault(); runQuery(s); }}
                  >
                    <SearchIcon size={14} aria-hidden className={styles.suggestIcon} />
                    <span>{s}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {mode === 'nl' && interpreted && (
          <div className={styles.interpret}>
            <Sparkles size={14} aria-hidden className={styles.interpretIcon} />
            <span className={styles.interpretText}>{interpreted}</span>
            {parsed && (
              <span className={styles.interpretBadges}>
                {parsed.types.map((t) => <Badge key={`t:${t}`} color={TYPE_COLOR[t] ?? 'slate'}>{titleCase(t)}</Badge>)}
                {parsed.status && <Badge color="green">{titleCase(parsed.status)}</Badge>}
                {parsed.year != null && <Badge color="indigo">{parsed.year}</Badge>}
              </span>
            )}
          </div>
        )}
      </div>

      <div className={styles.layout}>
        <div className={styles.main}>
          {ready && total > 0 && (
            <div className={styles.summary}>
              <Badge color="blue">{total} result{total === 1 ? '' : 's'}</Badge>
              <span className={styles.summaryText}>for “{debounced}”</span>
              {canSave && (
                <Button size="sm" variant="subtle" icon={<Save size={14} />} onClick={() => setSaveOpen(true)}>
                  Save this search
                </Button>
              )}
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
                <EmptyState icon={<SearchIcon size={20} />} title="No matches" message={`Nothing found for “${debounced}”. Try a different name or reference.`} />
              </div>
            </Card>
          )}

          <div className={styles.results}>
            {groups.map((g) => {
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
        </div>

        <aside className={styles.side}>
          <Card padded={false}>
            <CardHeader
              title={<span className={styles.sideTitle}><Bookmark size={16} aria-hidden /> Saved searches</span>}
              subtitle="Pinned queries you can re-run"
            />
            <div className={styles.sideBody}>
              {saved.isLoading ? (
                <p className={styles.sideMuted}>Loading…</p>
              ) : (saved.data?.saved.length ?? 0) === 0 ? (
                <p className={styles.sideMuted}>No saved searches yet. Run a search and choose “Save this search”.</p>
              ) : (
                <ul className={styles.savedList}>
                  {saved.data?.saved.map((s) => (
                    <li key={s.id} className={styles.savedItem}>
                      <button type="button" className={styles.savedRun} onClick={() => runQuery(s.query)}>
                        <span className={styles.savedName}>{s.name}</span>
                        <span className={styles.savedQuery}>{s.query}</span>
                      </button>
                      <button
                        type="button"
                        className={styles.savedDelete}
                        aria-label={`Delete saved search ${s.name}`}
                        onClick={() => deleteSaved.mutate(s.id)}
                        disabled={deleteSaved.isPending}
                      >
                        <X size={14} aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>

          <Card padded={false}>
            <CardHeader
              title={<span className={styles.sideTitle}><History size={16} aria-hidden /> Recent searches</span>}
              subtitle="Jump back to a recent query"
            />
            <div className={styles.sideBody}>
              {history.isLoading ? (
                <p className={styles.sideMuted}>Loading…</p>
              ) : recent.length === 0 ? (
                <p className={styles.sideMuted}>Your recent searches will appear here.</p>
              ) : (
                <div className={styles.recentChips}>
                  {recent.map((h) => (
                    <button key={h.query} type="button" className={styles.recentChip} onClick={() => runQuery(h.query)}>
                      <Clock size={12} aria-hidden className={styles.recentIcon} />
                      <span className={styles.recentText}>{h.query}</span>
                      <span className={styles.recentCount}>{h.resultsCount}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </Card>
        </aside>
      </div>

      <SaveSearchModal
        open={saveOpen}
        query={term.trim()}
        saving={createSaved.isPending}
        onClose={() => setSaveOpen(false)}
        onSave={(name) => createSaved.mutate({ name, query: term.trim(), filters: {} })}
      />
    </>
  );
}

/* ---------------- Save search modal ---------------- */
function SaveSearchModal({
  open, query, saving, onClose, onSave,
}: {
  open: boolean; query: string; saving: boolean;
  onClose: () => void; onSave: (name: string) => void;
}) {
  const [name, setName] = useState('');

  // Seed the name with the query text when the modal opens.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (open && seededFor !== query) {
    setSeededFor(query);
    setName(query);
  }
  if (!open && seededFor !== null) setSeededFor(null);

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title="Save this search"
      description={`Pin “${query}” so you can re-run it later.`}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" icon={<Save size={16} />} loading={saving} disabled={!name.trim()} onClick={() => onSave(name.trim())}>
          Save search
        </Button>
      </>}
    >
      <TextField label="Name" value={name} onChange={setName} placeholder="e.g. Bound CAT treaties 2026" required />
    </Modal>
  );
}
