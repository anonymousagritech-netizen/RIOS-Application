import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Building2, Network, Users, GitBranch, PlusCircle, Boxes, Landmark,
  Store, ChevronRight,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { KpiCard } from '../components/KpiCard';
import { Table, type Column, EmptyState } from '../components/Table';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Drawer } from '../components/Drawer';
import { Modal } from '../components/Modal';
import { BarChart } from '../components/BarChart';
import { DonutChart } from '../components/DonutChart';
import { FormField, FormSection, Select, TextField } from '../components/Form';
import type { TokenColor } from '../lib/status';
import { formatNumber, titleCase } from '../lib/format';
import { useAuth } from '../lib/auth';
import styles from './OrganizationPage.module.css';

/* ---------------- Types (mirror the /api/organization contract) ---------------- */
type UnitKind = 'group' | 'company' | 'branch' | 'department';

interface OrgUnit {
  id: string;
  code: string;
  name: string;
  kind: UnitKind;
  parentId: string | null;
  childCount: number;
  parentName: string | null;
}
interface KindCount {
  key: string;
  n: number;
}
interface OrgDepartment {
  id: string;
  name: string;
  parentName: string | null;
  headcount: number;
}
interface OrgTotals {
  units: number;
  departments: number;
  employees: number;
}
interface OrganizationResponse {
  units: OrgUnit[];
  byKind: KindCount[];
  departments: OrgDepartment[];
  totals: OrgTotals;
}

interface OrgUnitChild {
  id: string;
  code: string;
  name: string;
  kind: UnitKind;
}
interface OrgUnitDetail {
  id: string;
  code: string;
  name: string;
  kind: UnitKind;
  parentId: string | null;
  parentName: string | null;
  children: OrgUnitChild[];
}

/* Tree node built client-side from the flat units list. */
interface TreeNode extends OrgUnit {
  children: TreeNode[];
  depth: number;
}

/* ---------------- Constants ---------------- */
const KIND_OPTIONS: UnitKind[] = ['group', 'company', 'branch', 'department'];

const KIND_COLOR: Record<string, TokenColor> = {
  group: 'violet',
  company: 'indigo',
  branch: 'teal',
  department: 'amber',
};

const KIND_ICON: Record<UnitKind, typeof Boxes> = {
  group: Boxes,
  company: Landmark,
  branch: Store,
  department: Users,
};

const KindIcon = ({ kind, size = 16 }: { kind: UnitKind; size?: number }) => {
  const Icon = KIND_ICON[kind] ?? Building2;
  return <Icon size={size} />;
};

/* ---------------- Data hook ---------------- */
function useOrganization() {
  return useQuery({
    queryKey: ['organization'],
    queryFn: () => api<OrganizationResponse>('/api/organization'),
  });
}

/* Build an indented hierarchy from the flat units[] via parentId. */
function buildTree(units: OrgUnit[]): TreeNode[] {
  const byId = new Map<string, OrgUnit>();
  units.forEach((u) => byId.set(u.id, u));
  const childrenOf = new Map<string, OrgUnit[]>();
  const roots: OrgUnit[] = [];

  units.forEach((u) => {
    const hasParent = u.parentId != null && byId.has(u.parentId);
    if (hasParent) {
      const arr = childrenOf.get(u.parentId as string) ?? [];
      arr.push(u);
      childrenOf.set(u.parentId as string, arr);
    } else {
      roots.push(u);
    }
  });

  const sortByName = (a: OrgUnit, b: OrgUnit) => a.name.localeCompare(b.name);
  const walk = (unit: OrgUnit, depth: number): TreeNode => ({
    ...unit,
    depth,
    children: (childrenOf.get(unit.id) ?? []).sort(sortByName).map((c) => walk(c, depth + 1)),
  });

  return roots.sort(sortByName).map((r) => walk(r, 0));
}

export function OrganizationPage() {
  const { user } = useAuth();
  const canWrite = !!user?.permissions?.some((p) => p === 'platform:write' || p === 'admin:manage');

  const [showNew, setShowNew] = useState(false);
  const [openUnitId, setOpenUnitId] = useState<string | null>(null);

  const { data, isLoading } = useOrganization();
  const units = data?.units ?? [];
  const byKind = data?.byKind ?? [];
  const departments = data?.departments ?? [];
  const totals = data?.totals;

  const tree = useMemo(() => buildTree(units), [units]);
  const topLevel = useMemo(() => units.filter((u) => u.parentId == null).length, [units]);
  const companyCount = useMemo(
    () => byKind.find((k) => k.key === 'company')?.n ?? 0,
    [byKind],
  );

  const kindData = byKind.map((k) => ({ label: titleCase(k.key), value: k.n, status: k.key }));
  const kindMeta: Record<string, string> = {};
  byKind.forEach((k) => { kindMeta[k.key] = KIND_COLOR[k.key] ?? 'slate'; });

  // Largest teams first, top 8, for the departments bar chart.
  const topDepartments = useMemo(
    () => [...departments].sort((a, b) => b.headcount - a.headcount).slice(0, 8),
    [departments],
  );
  const deptBar = topDepartments.map((d) => ({ label: d.name, value: d.headcount }));
  const maxHeadcount = Math.max(1, ...departments.map((d) => d.headcount));

  const deptColumns: Column<OrgDepartment>[] = [
    {
      key: 'name', header: 'Department', sortValue: (r) => r.name,
      render: (r) => (
        <div className={styles.cellRow}>
          <span className={styles.deptIcon} aria-hidden><Users size={14} /></span>
          <span className={styles.cellMain}>{r.name}</span>
        </div>
      ),
    },
    {
      key: 'parent', header: 'Reports to', sortValue: (r) => r.parentName ?? '',
      render: (r) => r.parentName
        ? <span className={styles.cellSub}>{r.parentName}</span>
        : <span className={styles.cellMuted}>—</span>,
    },
    {
      key: 'headcount', header: 'Headcount', align: 'right', sortValue: (r) => r.headcount,
      render: (r) => (
        <div className={styles.headcountCell}>
          <div className={styles.hcBar}>
            <span className={styles.hcFill} style={{ width: `${(r.headcount / maxHeadcount) * 100}%` }} />
          </div>
          <span className={styles.num}>{formatNumber(r.headcount)}</span>
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Organization Management"
        description="The corporate reporting structure — group, company, branch and department units, their reporting lines and HR headcount across the enterprise."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Organization' }]}
        actions={canWrite ? (
          <Button variant="primary" icon={<PlusCircle size={16} />} onClick={() => setShowNew(true)}>
            New unit
          </Button>
        ) : undefined}
      />

      <div className={styles.kpis}>
        <KpiCard
          label="Org units"
          value={totals ? formatNumber(totals.units) : '—'}
          hint="Across the hierarchy"
          icon={<Network size={20} />}
          accent="var(--primary)"
          loading={isLoading}
        />
        <KpiCard
          label="Departments"
          value={totals ? formatNumber(totals.departments) : '—'}
          hint="HR reporting units"
          icon={<GitBranch size={20} />}
          accent="var(--accent-violet)"
          loading={isLoading}
        />
        <KpiCard
          label="Employees"
          value={totals ? formatNumber(totals.employees) : '—'}
          hint="Total headcount"
          icon={<Users size={20} />}
          accent="var(--accent-orange)"
          loading={isLoading}
        />
        <KpiCard
          label="Top-level entities"
          value={data ? formatNumber(topLevel) : '—'}
          hint={data ? `${formatNumber(companyCount)} companies` : undefined}
          icon={<Building2 size={20} />}
          accent="var(--accent-emerald)"
          loading={isLoading}
        />
      </div>

      <div className={styles.split}>
        <Card padded>
          <CardHeader title="Unit mix" subtitle="Distribution of units by kind" />
          {isLoading ? (
            <p className={styles.cellSub}>Loading structure…</p>
          ) : (
            <DonutChart
              data={kindData}
              metaColors={kindMeta}
              centerValue={totals ? String(totals.units) : undefined}
              centerLabel="units"
              emptyLabel="No units defined yet"
            />
          )}
        </Card>

        <Card padded>
          <CardHeader title="Largest teams" subtitle="Departments ranked by headcount" />
          {isLoading ? (
            <p className={styles.cellSub}>Loading departments…</p>
          ) : (
            <BarChart data={deptBar} emptyLabel="No departments with headcount yet" />
          )}
        </Card>
      </div>

      <Card padded style={{ marginBottom: 'var(--space-5)' }}>
        <CardHeader
          title="Reporting structure"
          subtitle="The organizational hierarchy — click a unit to inspect its direct reports"
        />
        {isLoading ? (
          <div className={styles.treeSkeleton}>
            {Array.from({ length: 5 }).map((_, i) => <span key={i} className={styles.skeletonRow} />)}
          </div>
        ) : tree.length === 0 ? (
          <EmptyState
            icon={<Network size={18} />}
            title="No organization units"
            message="Add a top-level group or company to start building the reporting structure."
          />
        ) : (
          <ul className={styles.tree}>
            {tree.map((node) => (
              <TreeRow key={node.id} node={node} onOpen={setOpenUnitId} />
            ))}
          </ul>
        )}
      </Card>

      <Card padded={false}>
        <CardHeader title="Departments & headcount" subtitle="HR departments and the size of each team" />
        <div className={styles.tableWrap}>
          <Table
            columns={deptColumns}
            rows={departments}
            loading={isLoading}
            rowKey={(r) => r.id}
            empty={<EmptyState icon={<Users size={18} />} title="No departments" message="HR departments will appear here once created." />}
            skeletonRows={5}
          />
        </div>
      </Card>

      <NewUnitModal open={showNew} onClose={() => setShowNew(false)} units={units} />
      <UnitDrawer unitId={openUnitId} onClose={() => setOpenUnitId(null)} onOpen={setOpenUnitId} />
    </>
  );
}

/* ---------------- Tree row (recursive) ---------------- */
function TreeRow({ node, onOpen }: { node: TreeNode; onOpen: (id: string) => void }) {
  return (
    <li className={styles.treeItem}>
      <button
        type="button"
        className={styles.treeNode}
        style={{ paddingLeft: `calc(var(--space-3) + ${node.depth} * var(--space-5))` }}
        onClick={() => onOpen(node.id)}
      >
        {node.depth > 0 && <span className={styles.treeConnector} aria-hidden />}
        <span className={styles.nodeIcon} data-kind={node.kind} aria-hidden>
          <KindIcon kind={node.kind} />
        </span>
        <span className={styles.nodeText}>
          <span className={styles.nodeName}>{node.name}</span>
          <span className={styles.nodeCode}>{node.code}</span>
        </span>
        <Badge color={KIND_COLOR[node.kind] ?? 'slate'}>{titleCase(node.kind)}</Badge>
        {node.childCount > 0 && (
          <span className={styles.childCount}>
            {formatNumber(node.childCount)} {node.childCount === 1 ? 'child' : 'children'}
          </span>
        )}
        <ChevronRight size={15} className={styles.nodeChevron} aria-hidden />
      </button>
      {node.children.length > 0 && (
        <ul className={styles.tree}>
          {node.children.map((child) => (
            <TreeRow key={child.id} node={child} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </li>
  );
}

/* ---------------- Unit detail drawer ---------------- */
function UnitDrawer({
  unitId, onClose, onOpen,
}: { unitId: string | null; onClose: () => void; onOpen: (id: string) => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['organization', 'unit', unitId],
    queryFn: () => api<OrgUnitDetail>(`/api/organization/${unitId}`),
    enabled: !!unitId,
  });

  const childColumns: Column<OrgUnitChild>[] = [
    {
      key: 'name', header: 'Unit', sortValue: (r) => r.name,
      render: (r) => (
        <div className={styles.cellRow}>
          <span className={styles.nodeIcon} data-kind={r.kind} aria-hidden><KindIcon kind={r.kind} size={14} /></span>
          <div>
            <div className={styles.cellMain}>{r.name}</div>
            <div className={styles.cellSub}>{r.code}</div>
          </div>
        </div>
      ),
    },
    {
      key: 'kind', header: 'Kind', align: 'right', sortValue: (r) => r.kind,
      render: (r) => <Badge color={KIND_COLOR[r.kind] ?? 'slate'}>{titleCase(r.kind)}</Badge>,
    },
  ];

  return (
    <Drawer
      open={!!unitId}
      onClose={onClose}
      title={data ? data.name : 'Unit'}
      subtitle={data ? `${titleCase(data.kind)} · ${data.code}` : undefined}
      width={460}
    >
      {isLoading || !data ? (
        <p className={styles.cellSub}>Loading unit…</p>
      ) : (
        <div className={styles.drawerBody}>
          <div className={styles.metaGrid}>
            <div className={styles.metaItem}>
              <span className={styles.metaLabel}>Kind</span>
              <Badge color={KIND_COLOR[data.kind] ?? 'slate'}>{titleCase(data.kind)}</Badge>
            </div>
            <div className={styles.metaItem}>
              <span className={styles.metaLabel}>Code</span>
              <span className={styles.metaValue}>{data.code}</span>
            </div>
            <div className={styles.metaItem}>
              <span className={styles.metaLabel}>Reports to</span>
              <span className={styles.metaValue}>{data.parentName ?? '—'}</span>
            </div>
            <div className={styles.metaItem}>
              <span className={styles.metaLabel}>Direct reports</span>
              <span className={styles.metaValue}>{formatNumber(data.children.length)}</span>
            </div>
          </div>

          <div>
            <h3 className={styles.drawerSectionTitle}>Direct reports</h3>
            <Table
              columns={childColumns}
              rows={data.children}
              rowKey={(r) => r.id}
              onRowClick={(r) => onOpen(r.id)}
              empty={<EmptyState icon={<GitBranch size={16} />} title="No child units" message="This unit has no direct reports." />}
            />
          </div>
        </div>
      )}
    </Drawer>
  );
}

/* ---------------- New unit modal ---------------- */
function NewUnitModal({
  open, onClose, units,
}: { open: boolean; onClose: () => void; units: OrgUnit[] }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState({ code: '', name: '', kind: 'company' as UnitKind, parentId: '' });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<{ id: string }>('/api/organization', { body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['organization'] });
      toast.success('Organization unit created');
      onClose();
      setF({ code: '', name: '', kind: 'company', parentId: '' });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not create the unit.'),
  });

  const submit = () => {
    setError(null);
    create.mutate({
      code: f.code.trim(),
      name: f.name.trim(),
      kind: f.kind,
      parentId: f.parentId || undefined,
    });
  };

  const valid = f.code.trim().length > 0 && f.name.trim().length > 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title="New organization unit"
      description="Add a node to the corporate reporting structure. Leave the parent empty for a top-level entity."
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!valid}>Create unit</Button>
      </>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        <FormSection title="Identity">
          <TextField label="Code" value={f.code} onChange={set('code')} required placeholder="e.g. RIOS-EU" hint="Unique short identifier." />
          <TextField label="Name" value={f.name} onChange={set('name')} required placeholder="e.g. RIOS Europe" />
        </FormSection>

        <FormSection title="Placement" description="Where this unit sits in the hierarchy.">
          <FormField label="Kind" required>
            <Select value={f.kind} onChange={(e) => set('kind')(e.target.value)}>
              {KIND_OPTIONS.map((k) => <option key={k} value={k}>{titleCase(k)}</option>)}
            </Select>
          </FormField>
          <FormField label="Parent unit" hint="Optional — omit for a top-level entity.">
            <Select value={f.parentId} onChange={(e) => set('parentId')(e.target.value)}>
              <option value="">None (top-level)</option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>{u.name} ({titleCase(u.kind)})</option>
              ))}
            </Select>
          </FormField>
        </FormSection>

        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </div>
    </Modal>
  );
}
