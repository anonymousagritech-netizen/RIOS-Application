import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card } from '../components/Card';
import { Tabs } from '../components/Tabs';
import { Table, type Column, EmptyState } from '../components/Table';
import { StatusPill } from '../components/Badge';
import { Button } from '../components/Button';
import { KpiCard } from '../components/KpiCard';
import { Modal, ConfirmDialog } from '../components/Modal';
import { FormField, Input, Select, TextField, Textarea } from '../components/Form';
import { formatDate, titleCase } from '../lib/format';
import { api, qs, ApiError } from '../lib/api';
import { UserRound, CalendarClock, Building2 } from 'lucide-react';
import shared from './shared.module.css';

/* ---------------- Types ---------------- */
interface Department {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
  costCentre: string | null;
  employeeCount: number;
}
interface Employee {
  id: string;
  employeeNo: string;
  firstName: string;
  lastName: string;
  email: string | null;
  departmentId: string | null;
  position: string | null;
  managerId: string | null;
  hireDate: string | null;
  baseSalaryMinor: number | null;
  currency: string | null;
  status: string;
  departmentName: string | null;
}
interface LeaveRequest {
  id: string;
  employeeId: string;
  kind: string;
  startDate: string;
  endDate: string;
  days: number;
  reason: string | null;
  status: string;
  decidedBy: string | null;
  decidedAt: string | null;
  employeeName: string;
}

/* ---------------- Data hooks (local) ---------------- */
function useDepartments() {
  return useQuery({
    queryKey: ['hr', 'departments'],
    queryFn: () => api<{ departments: Department[] }>('/api/hr/departments'),
  });
}
function useEmployees(params: { departmentId?: string; status?: string }) {
  return useQuery({
    queryKey: ['hr', 'employees', params],
    queryFn: () => api<{ employees: Employee[] }>(`/api/hr/employees${qs(params)}`),
  });
}
function useLeave(params: { status?: string; employeeId?: string }) {
  return useQuery({
    queryKey: ['hr', 'leave', params],
    queryFn: () => api<{ leaveRequests: LeaveRequest[] }>(`/api/hr/leave${qs(params)}`),
  });
}
function useCreateDepartment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { code: string; name: string; costCentre?: string }) =>
      api<{ id: string; code: string }>('/api/hr/departments', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hr', 'departments'] }),
  });
}
function useCreateEmployee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      firstName: string; lastName: string; email?: string; departmentId?: string;
      position?: string; hireDate?: string; baseSalary?: number; currency?: string;
    }) => api<{ id: string; employeeNo: string }>('/api/hr/employees', { body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hr', 'employees'] });
      qc.invalidateQueries({ queryKey: ['hr', 'departments'] });
    },
  });
}
function useCreateLeave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      employeeId: string; kind: string; startDate: string; endDate: string; days: number; reason?: string;
    }) => api<{ id: string; status: string }>('/api/hr/leave', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hr', 'leave'] }),
  });
}
function useDecideLeave() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'approved' | 'rejected' }) =>
      api<{ id: string; status: string }>(`/api/hr/leave/${id}/decide`, { body: { decision } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hr', 'leave'] });
      qc.invalidateQueries({ queryKey: ['hr', 'employees'] });
    },
  });
}

const TABS = [
  { id: 'people', label: 'People' },
  { id: 'departments', label: 'Departments' },
  { id: 'leave', label: 'Leave' },
];

const LEAVE_KINDS = ['annual', 'sick', 'unpaid', 'parental', 'other'];
const LEAVE_STATUSES = ['pending', 'approved', 'rejected'];

export function HrmsPage() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('hr:write');
  const [tab, setTab] = useState('people');

  const employees = useEmployees({});
  const leave = useLeave({});

  const employeeCount = employees.data?.employees?.length ?? 0;
  const pendingLeave = (leave.data?.leaveRequests ?? []).filter((l) => l.status === 'pending').length;

  return (
    <>
      <PageHeader
        title="People"
        description="Departments, employees and leave requests across the organisation."
      />

      <div className={shared.kpiGrid} style={{ marginBottom: 'var(--space-5)' }}>
        <KpiCard label="Employees" value={employeeCount} loading={employees.isLoading} icon={<UserRound size={20} />} />
        <KpiCard label="Pending leave" value={pendingLeave} loading={leave.isLoading} icon={<CalendarClock size={20} />} />
      </div>

      <Card padded={false}>
        <div style={{ padding: '0 var(--space-4)' }}>
          <Tabs tabs={TABS} active={tab} onChange={setTab} />
        </div>
        <div style={{ padding: 'var(--space-5)' }}>
          {tab === 'people' && <PeopleTab canWrite={canWrite} />}
          {tab === 'departments' && <DepartmentsTab canWrite={canWrite} />}
          {tab === 'leave' && <LeaveTab canWrite={canWrite} />}
        </div>
      </Card>
    </>
  );
}

/* ---------------- People tab ---------------- */
function PeopleTab({ canWrite }: { canWrite: boolean }) {
  const [departmentId, setDepartmentId] = useState('');
  const [showNew, setShowNew] = useState(false);
  const { data, isLoading } = useEmployees({ departmentId: departmentId || undefined });
  const { data: depts } = useDepartments();
  const departments = depts?.departments ?? [];
  const rows = data?.employees ?? [];

  const columns: Column<Employee>[] = [
    {
      key: 'name',
      header: 'Employee',
      sortValue: (e) => `${e.lastName} ${e.firstName}`,
      render: (e) => (
        <div>
          <div className={shared.cellMain}>{e.firstName} {e.lastName}</div>
          <div className={shared.cellRef}>{e.employeeNo}</div>
        </div>
      ),
    },
    { key: 'department', header: 'Department', sortValue: (e) => e.departmentName ?? '', render: (e) => e.departmentName ?? '-' },
    { key: 'position', header: 'Position', sortValue: (e) => e.position ?? '', render: (e) => e.position ?? '-' },
    { key: 'status', header: 'Status', align: 'right', sortValue: (e) => e.status, render: (e) => <StatusPill status={e.status} /> },
  ];

  return (
    <>
      <div className={shared.toolbar} style={{ marginBottom: 'var(--space-4)' }}>
        <div className={shared.filter}>
          <span className={shared.filterLabel}>Department</span>
          <Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} aria-label="Filter by department">
            <option value="">All</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select>
        </div>
        <div className={shared.spacer} />
        <span className={shared.cellSub}>{rows.length} result{rows.length === 1 ? '' : 's'}</span>
        {canWrite && (
          <Button variant="primary" onClick={() => setShowNew(true)} icon={<span aria-hidden>+</span>}>New employee</Button>
        )}
      </div>

      <Table
        columns={columns}
        rows={data?.employees}
        loading={isLoading}
        rowKey={(e) => e.id}
        empty={<EmptyState title="No employees" message="No employees match the current filter." icon={<UserRound size={16} />} />}
      />

      <NewEmployeeModal open={showNew} onClose={() => setShowNew(false)} departments={departments} />
    </>
  );
}

function NewEmployeeModal({ open, onClose, departments }: { open: boolean; onClose: () => void; departments: Department[] }) {
  const toast = useToast();
  const create = useCreateEmployee();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [position, setPosition] = useState('');
  const [hireDate, setHireDate] = useState('');
  const [baseSalary, setBaseSalary] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setFirstName(''); setLastName(''); setEmail(''); setDepartmentId('');
    setPosition(''); setHireDate(''); setBaseSalary(''); setCurrency('USD'); setError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!firstName.trim() || !lastName.trim()) { setError('First and last name are required.'); return; }
    const salary = baseSalary ? Number(baseSalary) : undefined;
    if (salary !== undefined && (Number.isNaN(salary) || salary < 0)) { setError('Enter a valid base salary.'); return; }
    try {
      const res = await create.mutateAsync({
        firstName,
        lastName,
        email: email || undefined,
        departmentId: departmentId || undefined,
        position: position || undefined,
        hireDate: hireDate || undefined,
        baseSalary: salary,
        currency: salary !== undefined ? currency : undefined,
      });
      toast.success(`Employee ${res.employeeNo} created`);
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the employee.');
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => { reset(); onClose(); }}
      title="New employee"
      description="Register an employee. Base salary is entered in major currency units."
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!firstName.trim() || !lastName.trim()}>Create employee</Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <div className={shared.grid2} style={{ display: 'grid' }}>
          <TextField label="First name" value={firstName} onChange={setFirstName} required placeholder="Jane" />
          <TextField label="Last name" value={lastName} onChange={setLastName} required placeholder="Doe" />
        </div>
        <TextField label="Email" value={email} onChange={setEmail} type="email" placeholder="jane.doe@example.com" />
        <div className={shared.grid2} style={{ display: 'grid' }}>
          <FormField label="Department">
            <Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
              <option value="">Unassigned</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </Select>
          </FormField>
          <TextField label="Position" value={position} onChange={setPosition} placeholder="e.g. Underwriter" />
        </div>
        <div className={shared.grid2} style={{ display: 'grid' }}>
          <TextField label="Hire date" value={hireDate} onChange={setHireDate} type="date" />
          <FormField label="Base salary (major units)">
            <div className={shared.toolbar}>
              <Input type="number" min="0" step="any" value={baseSalary} onChange={(e) => setBaseSalary(e.target.value)} placeholder="e.g. 85000" style={{ flex: 1 }} />
              <Select value={currency} onChange={(e) => setCurrency(e.target.value)} aria-label="Currency">
                {['USD', 'EUR', 'GBP', 'JPY'].map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            </div>
          </FormField>
        </div>
        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}

/* ---------------- Departments tab ---------------- */
function DepartmentsTab({ canWrite }: { canWrite: boolean }) {
  const [showNew, setShowNew] = useState(false);
  const { data, isLoading } = useDepartments();
  const rows = data?.departments ?? [];

  const columns: Column<Department>[] = [
    { key: 'code', header: 'Code', sortValue: (d) => d.code, render: (d) => <span className={shared.cellRef}>{d.code}</span> },
    { key: 'name', header: 'Department', sortValue: (d) => d.name, render: (d) => <span className={shared.cellMain}>{d.name}</span> },
    { key: 'costCentre', header: 'Cost centre', sortValue: (d) => d.costCentre ?? '', render: (d) => d.costCentre ?? '-' },
    { key: 'employeeCount', header: 'Employees', align: 'right', sortValue: (d) => d.employeeCount, render: (d) => d.employeeCount },
  ];

  return (
    <>
      <div className={shared.toolbar} style={{ marginBottom: 'var(--space-4)' }}>
        <div className={shared.spacer} />
        <span className={shared.cellSub}>{rows.length} department{rows.length === 1 ? '' : 's'}</span>
        {canWrite && (
          <Button variant="primary" onClick={() => setShowNew(true)} icon={<span aria-hidden>+</span>}>New department</Button>
        )}
      </div>

      <Table
        columns={columns}
        rows={data?.departments}
        loading={isLoading}
        rowKey={(d) => d.id}
        empty={<EmptyState title="No departments" message="Create a department to organise employees." icon={<Building2 size={16} />} />}
      />

      <NewDepartmentModal open={showNew} onClose={() => setShowNew(false)} />
    </>
  );
}

function NewDepartmentModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const create = useCreateDepartment();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [costCentre, setCostCentre] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reset = () => { setCode(''); setName(''); setCostCentre(''); setError(null); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!code.trim() || !name.trim()) { setError('Code and name are required.'); return; }
    try {
      const res = await create.mutateAsync({ code, name, costCentre: costCentre || undefined });
      toast.success(`Department ${res.code} created`);
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the department.');
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => { reset(); onClose(); }}
      title="New department"
      description="Create a department to group employees."
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!code.trim() || !name.trim()}>Create department</Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <div className={shared.grid2} style={{ display: 'grid' }}>
          <TextField label="Code" value={code} onChange={setCode} required placeholder="e.g. UW" />
          <TextField label="Cost centre" value={costCentre} onChange={setCostCentre} placeholder="optional" />
        </div>
        <TextField label="Name" value={name} onChange={setName} required placeholder="e.g. Underwriting" />
        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}

/* ---------------- Leave tab ---------------- */
function LeaveTab({ canWrite }: { canWrite: boolean }) {
  const toast = useToast();
  const [status, setStatus] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [decision, setDecision] = useState<{ id: string; to: 'approved' | 'rejected' } | null>(null);

  const { data, isLoading } = useLeave({ status: status || undefined });
  const decide = useDecideLeave();
  const rows = data?.leaveRequests ?? [];

  const runDecision = async () => {
    if (!decision) return;
    try {
      const res = await decide.mutateAsync({ id: decision.id, decision: decision.to });
      toast.success(`Leave request ${titleCase(res.status)}`);
      setDecision(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not record the decision.');
      setDecision(null);
    }
  };

  const columns: Column<LeaveRequest>[] = [
    { key: 'employee', header: 'Employee', sortValue: (l) => l.employeeName, render: (l) => <span className={shared.cellMain}>{l.employeeName}</span> },
    { key: 'kind', header: 'Kind', sortValue: (l) => l.kind, render: (l) => titleCase(l.kind) },
    {
      key: 'dates',
      header: 'Dates',
      sortValue: (l) => l.startDate,
      render: (l) => <span>{formatDate(l.startDate)} – {formatDate(l.endDate)}</span>,
    },
    { key: 'days', header: 'Days', align: 'right', sortValue: (l) => l.days, render: (l) => l.days },
    { key: 'status', header: 'Status', sortValue: (l) => l.status, render: (l) => <StatusPill status={l.status} /> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (l) =>
        canWrite && l.status === 'pending' ? (
          <div className={shared.toolbar} style={{ justifyContent: 'flex-end' }}>
            <Button size="sm" variant="secondary" onClick={() => setDecision({ id: l.id, to: 'approved' })}>Approve</Button>
            <Button size="sm" variant="danger" onClick={() => setDecision({ id: l.id, to: 'rejected' })}>Reject</Button>
          </div>
        ) : (
          <span className={shared.cellSub}>-</span>
        ),
    },
  ];

  return (
    <>
      <div className={shared.toolbar} style={{ marginBottom: 'var(--space-4)' }}>
        <div className={shared.filter}>
          <span className={shared.filterLabel}>Status</span>
          <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
            <option value="">All</option>
            {LEAVE_STATUSES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
          </Select>
        </div>
        <div className={shared.spacer} />
        <span className={shared.cellSub}>{rows.length} request{rows.length === 1 ? '' : 's'}</span>
        {canWrite && (
          <Button variant="primary" onClick={() => setShowNew(true)} icon={<span aria-hidden>+</span>}>Request leave</Button>
        )}
      </div>

      <Table
        columns={columns}
        rows={data?.leaveRequests}
        loading={isLoading}
        rowKey={(l) => l.id}
        empty={<EmptyState title="No leave requests" message="No leave requests match the current filter." icon={<CalendarClock size={16} />} />}
      />

      <RequestLeaveModal open={showNew} onClose={() => setShowNew(false)} />

      <ConfirmDialog
        open={!!decision}
        onClose={() => setDecision(null)}
        onConfirm={runDecision}
        loading={decide.isPending}
        destructive={decision?.to === 'rejected'}
        title={decision?.to === 'approved' ? 'Approve leave request?' : 'Reject leave request?'}
        confirmLabel={decision?.to === 'approved' ? 'Approve' : 'Reject'}
        message={
          decision?.to === 'approved'
            ? 'Approving this request will set the employee status to on leave.'
            : 'This rejects the leave request. The employee remains active.'
        }
      />
    </>
  );
}

function RequestLeaveModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const create = useCreateLeave();
  const { data } = useEmployees({});
  const employees = data?.employees ?? [];

  const [employeeId, setEmployeeId] = useState('');
  const [kind, setKind] = useState('annual');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [days, setDays] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setEmployeeId(''); setKind('annual'); setStartDate(''); setEndDate(''); setDays(''); setReason(''); setError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const numDays = Number(days);
    if (!employeeId) { setError('Select an employee.'); return; }
    if (!startDate || !endDate) { setError('Enter start and end dates.'); return; }
    if (Number.isNaN(numDays) || numDays < 0) { setError('Enter the number of days.'); return; }
    try {
      const res = await create.mutateAsync({
        employeeId,
        kind,
        startDate,
        endDate,
        days: numDays,
        reason: reason || undefined,
      });
      toast.success(`Leave request ${titleCase(res.status)}`);
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the leave request.');
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => { reset(); onClose(); }}
      title="Request leave"
      description="File a leave request for an employee."
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!employeeId || !startDate || !endDate || !days}>Submit request</Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <FormField label="Employee" required>
          <Select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            <option value="">Select an employee…</option>
            {employees.map((emp) => (
              <option key={emp.id} value={emp.id}>{emp.firstName} {emp.lastName} ({emp.employeeNo})</option>
            ))}
          </Select>
        </FormField>
        <div className={shared.grid2} style={{ display: 'grid' }}>
          <FormField label="Kind" required>
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              {LEAVE_KINDS.map((k) => <option key={k} value={k}>{titleCase(k)}</option>)}
            </Select>
          </FormField>
          <TextField label="Days" value={days} onChange={setDays} type="number" required placeholder="e.g. 5" />
        </div>
        <div className={shared.grid2} style={{ display: 'grid' }}>
          <TextField label="Start date" value={startDate} onChange={setStartDate} type="date" required />
          <TextField label="End date" value={endDate} onChange={setEndDate} type="date" required />
        </div>
        <FormField label="Reason">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Optional note" rows={3} />
        </FormField>
        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}
