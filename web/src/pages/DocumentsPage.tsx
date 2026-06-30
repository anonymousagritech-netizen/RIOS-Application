import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { Table, type Column, EmptyState } from '../components/Table';
import { StatusPill } from '../components/Badge';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { FormField, Input, Select, Textarea, TextField } from '../components/Form';
import { Tabs } from '../components/Tabs';
import { formatDate, titleCase } from '../lib/format';
import { api, qs, ApiError } from '../lib/api';
import shared from './shared.module.css';

const DOC_TYPES = ['SLIP', 'COVER_NOTE', 'ENDORSEMENT', 'STATEMENT', 'LETTER', 'CONTRACT', 'OTHER'];

/* ---------------- Local data hooks ---------------- */
interface DocTemplate { id: string; key: string; name: string; doc_type: string | null; version: number | null }
interface DocSummary { id: string; title: string; doc_type: string | null; status: string; created_at: string }
interface DocDetail extends DocSummary { content: string }

function useDocTemplates() {
  return useQuery({
    queryKey: ['doc-templates'],
    queryFn: () => api<{ templates: DocTemplate[] }>('/api/documents/templates'),
  });
}

function useDocuments(docType: string) {
  return useQuery({
    queryKey: ['documents', docType],
    queryFn: () => api<{ documents: DocSummary[] }>(`/api/documents${qs({ docType })}`),
  });
}

function useDocument(id: string | null) {
  return useQuery({
    queryKey: ['document', id],
    queryFn: () => api<DocDetail>(`/api/documents/${id}`),
    enabled: !!id,
  });
}

function useCreateTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { key: string; name: string; docType?: string; body: string }) =>
      api<DocTemplate>('/api/documents/templates', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['doc-templates'] }),
  });
}

function useGenerateDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      templateKey?: string; templateId?: string; title: string;
      docType?: string; context: Record<string, unknown>;
    }) => api<{ id: string; content: string }>('/api/documents/generate', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['documents'] }),
  });
}

/* ---------------- Page ---------------- */
export function DocumentsPage() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('documents:write');
  const [tab, setTab] = useState('templates');

  return (
    <>
      <PageHeader
        title="Documents"
        description="Author reusable templates with merge placeholders and generate documents across the portfolio."
      />

      <Tabs
        tabs={[
          { id: 'templates', label: 'Templates' },
          { id: 'generate', label: 'Generate' },
          { id: 'documents', label: 'Documents' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'templates' && <TemplatesTab canWrite={canWrite} />}
      {tab === 'generate' && <GenerateTab canWrite={canWrite} />}
      {tab === 'documents' && <DocumentsTab />}
    </>
  );
}

/* ---------------- Templates tab ---------------- */
function TemplatesTab({ canWrite }: { canWrite: boolean }) {
  const { data, isLoading } = useDocTemplates();
  const [showNew, setShowNew] = useState(false);

  const columns: Column<DocTemplate>[] = [
    { key: 'key', header: 'Key', sortValue: (t) => t.key, render: (t) => <span className={shared.cellRef}>{t.key}</span> },
    { key: 'name', header: 'Name', sortValue: (t) => t.name, render: (t) => <span className={shared.cellMain}>{t.name}</span> },
    { key: 'docType', header: 'Type', sortValue: (t) => t.doc_type ?? '', render: (t) => titleCase(t.doc_type) || '—' },
    { key: 'version', header: 'Version', align: 'right', sortValue: (t) => t.version ?? 0, render: (t) => t.version ?? '—' },
  ];

  return (
    <>
      <Card padded={false}>
        <div style={{ padding: 'var(--space-4) var(--space-5) 0' }}>
          <CardHeader
            title="Templates"
            subtitle="Bodies may contain {{ dotted.path }} placeholders merged from the generation context."
            actions={
              canWrite ? (
                <Button size="sm" variant="secondary" onClick={() => setShowNew(true)} icon={<span aria-hidden>+</span>}>
                  New template
                </Button>
              ) : null
            }
          />
        </div>
        <Table
          columns={columns}
          rows={data?.templates}
          loading={isLoading}
          rowKey={(t) => t.id}
          empty={<EmptyState title="No templates" message="Create a template to start generating documents." icon="▤" />}
        />
      </Card>

      <NewTemplateModal open={showNew} onClose={() => setShowNew(false)} />
    </>
  );
}

function NewTemplateModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const create = useCreateTemplate();
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [docType, setDocType] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reset = () => { setKey(''); setName(''); setDocType(''); setBody(''); setError(null); };
  const close = () => { reset(); onClose(); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!key.trim() || !name.trim() || !body.trim()) { setError('Key, name and body are required.'); return; }
    try {
      await create.mutateAsync({
        key: key.trim(),
        name: name.trim(),
        docType: docType || undefined,
        body,
      });
      toast.success(`Template “${name}” created`);
      close();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the template.');
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="New template"
      description="Author a reusable document body with merge placeholders."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={create.isPending} disabled={!key.trim() || !name.trim() || !body.trim()}>
            Create template
          </Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <div className={shared.grid2} style={{ display: 'grid' }}>
          <TextField label="Key" value={key} onChange={setKey} required placeholder="e.g. cover_note" />
          <TextField label="Name" value={name} onChange={setName} required placeholder="e.g. Cover note" />
        </div>
        <FormField label="Document type">
          <Select value={docType} onChange={(e) => setDocType(e.target.value)}>
            <option value="">Unspecified</option>
            {DOC_TYPES.map((d) => <option key={d} value={d}>{titleCase(d)}</option>)}
          </Select>
        </FormField>
        <FormField label="Body" required hint="Use {{ dotted.path }} placeholders — e.g. {{ contract.reference }} — resolved from the generation context.">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={10}
            placeholder={'Cover note for {{ contract.reference }}\nCedent: {{ cedent.legalName }}\nPeriod: {{ contract.periodStart }}'}
            style={{ fontFamily: 'var(--font-mono)' }}
          />
        </FormField>
        {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}

/* ---------------- Generate tab ---------------- */
function GenerateTab({ canWrite }: { canWrite: boolean }) {
  const toast = useToast();
  const { data: templates } = useDocTemplates();
  const generate = useGenerateDocument();
  const [templateKey, setTemplateKey] = useState('');
  const [title, setTitle] = useState('');
  const [context, setContext] = useState('{\n  \n}');
  const [rendered, setRendered] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tpls = templates?.templates ?? [];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!templateKey) { setError('Pick a template.'); return; }
    if (!title.trim()) { setError('A title is required.'); return; }
    let ctx: Record<string, unknown>;
    try {
      const parsed = context.trim() ? JSON.parse(context) : {};
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setError('Context must be a JSON object.');
        return;
      }
      ctx = parsed as Record<string, unknown>;
    } catch {
      setError('Context is not valid JSON.');
      return;
    }
    try {
      const res = await generate.mutateAsync({ templateKey, title: title.trim(), context: ctx });
      setRendered(res.content);
      toast.success('Document generated');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not generate the document.');
    }
  };

  if (!canWrite) {
    return (
      <Card>
        <EmptyState
          title="Read-only access"
          message="You need the documents:write permission to generate documents."
          icon="🔒"
        />
      </Card>
    );
  }

  return (
    <div className={shared.cols} style={{ display: 'grid' }}>
      <Card>
        <CardHeader title="Generate a document" subtitle="Merge a template body with a context object." />
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <FormField label="Template" required>
            <Select value={templateKey} onChange={(e) => setTemplateKey(e.target.value)}>
              <option value="">Select a template…</option>
              {tpls.map((t) => <option key={t.id} value={t.key}>{t.name} ({t.key})</option>)}
            </Select>
          </FormField>
          <TextField label="Title" value={title} onChange={setTitle} required placeholder="e.g. Cover note — NAP QS 2026" />
          <FormField label="Context (JSON)" hint="Object whose keys back the {{ dotted.path }} placeholders.">
            <Textarea
              value={context}
              onChange={(e) => setContext(e.target.value)}
              rows={10}
              spellCheck={false}
              style={{ fontFamily: 'var(--font-mono)' }}
              placeholder={'{\n  "contract": { "reference": "C-0001" }\n}'}
            />
          </FormField>
          {error && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">{error}</p>}
          <div>
            <Button variant="primary" onClick={submit} loading={generate.isPending} disabled={!templateKey || !title.trim()}>
              Generate
            </Button>
          </div>
        </form>
      </Card>

      <Card>
        <CardHeader title="Rendered output" subtitle="Result of the merge." />
        {rendered != null ? (
          <pre
            style={{
              margin: 0,
              padding: 'var(--space-4)',
              background: 'var(--surface-2)',
              borderRadius: 'var(--radius-md)',
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-sm)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {rendered}
          </pre>
        ) : (
          <EmptyState title="Nothing generated yet" message="Pick a template and run the merge to preview output." icon="◷" />
        )}
      </Card>
    </div>
  );
}

/* ---------------- Documents tab ---------------- */
function DocumentsTab() {
  const [docType, setDocType] = useState('');
  const { data, isLoading } = useDocuments(docType);
  const [openId, setOpenId] = useState<string | null>(null);

  const columns: Column<DocSummary>[] = [
    { key: 'title', header: 'Title', sortValue: (d) => d.title, render: (d) => <span className={shared.cellMain}>{d.title}</span> },
    { key: 'docType', header: 'Type', sortValue: (d) => d.doc_type ?? '', render: (d) => titleCase(d.doc_type) || '—' },
    { key: 'status', header: 'Status', sortValue: (d) => d.status, render: (d) => <StatusPill status={d.status} /> },
    { key: 'created', header: 'Created', align: 'right', sortValue: (d) => d.created_at, render: (d) => formatDate(d.created_at) },
  ];

  return (
    <>
      <Card padded={false}>
        <div style={{ padding: 'var(--space-4)' }} className={shared.toolbar}>
          <div className={shared.filter}>
            <span className={shared.filterLabel}>Type</span>
            <Select value={docType} onChange={(e) => setDocType(e.target.value)} aria-label="Filter by document type">
              <option value="">All</option>
              {DOC_TYPES.map((d) => <option key={d} value={d}>{titleCase(d)}</option>)}
            </Select>
          </div>
          <div className={shared.spacer} />
          <span className={shared.cellSub}>
            {data?.documents.length ?? 0} document{(data?.documents.length ?? 0) === 1 ? '' : 's'}
          </span>
        </div>
        <Table
          columns={columns}
          rows={data?.documents}
          loading={isLoading}
          rowKey={(d) => d.id}
          onRowClick={(d) => setOpenId(d.id)}
          empty={<EmptyState title="No documents" message="Generate a document to see it here." icon="▤" />}
        />
      </Card>

      <DocumentModal id={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

function DocumentModal({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data, isLoading, isError } = useDocument(id);

  return (
    <Modal
      open={!!id}
      onClose={onClose}
      title={data?.title ?? 'Document'}
      description={data ? `${titleCase(data.doc_type) || 'Document'} · ${formatDate(data.created_at)}` : undefined}
      size="lg"
      footer={<Button variant="ghost" onClick={onClose}>Close</Button>}
    >
      {isLoading && <p className={shared.cellSub}>Loading…</p>}
      {isError && <p style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }} role="alert">Could not load the document.</p>}
      {data && (
        <pre
          style={{
            margin: 0,
            padding: 'var(--space-4)',
            background: 'var(--surface-2)',
            borderRadius: 'var(--radius-md)',
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-sm)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: '60vh',
            overflow: 'auto',
          }}
        >
          {data.content}
        </pre>
      )}
    </Modal>
  );
}
