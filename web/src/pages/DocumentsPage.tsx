import { useState, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';
import { PageHeader } from '../components/PageHeader';
import { Card, CardHeader } from '../components/Card';
import { Table, type Column, EmptyState } from '../components/Table';
import { StatusPill, Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { FormField, FormSection, Input, Select, Textarea, TextField } from '../components/Form';
import { Tabs } from '../components/Tabs';
import { KpiCard } from '../components/KpiCard';
import { formatDate, formatNumber, titleCase } from '../lib/format';
import { api, qs, ApiError } from '../lib/api';
import {
  DOC_CATEGORIES, ACCEPT_EXTENSIONS, ALLOWED_LABEL, inferMimeType, readFileAsBase64,
  downloadBase64, DocumentPreviewModal, type DocContent,
} from '../components/documentShared';
import {
  FileText, Lock, Clock, FolderOpen, LayoutTemplate, FileStack, Sparkles, Search, Upload, Download, Eye,
} from 'lucide-react';
import shared from './shared.module.css';
import styles from './DocumentsPage.module.css';

const DOC_TYPES = ['SLIP', 'COVER_NOTE', 'ENDORSEMENT', 'STATEMENT', 'LETTER', 'CONTRACT', 'OTHER'];

/* ---------------- Local data hooks ---------------- */
interface DocTemplate { id: string; key: string; name: string; doc_type: string | null; version: number | null }
interface DocSummary { id: string; title: string; doc_type: string | null; status: string; created_at: string }
interface SearchRow {
  id: string;
  title: string;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  category: string | null;
  docStatus: string | null;
  currentVersion: number | null;
  tags: string[] | null;
  docType: string | null;
  createdAt: string;
}

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

interface SearchParams { q?: string; entityType?: string; category?: string; tag?: string }
function useSearchDocuments(params: SearchParams) {
  return useQuery({
    queryKey: ['documents-search', params],
    queryFn: () => api<{ documents: SearchRow[] }>(`/api/documents/search${qs(params as Record<string, string | undefined>)}`),
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
      docType?: string; entityType?: string; entityId?: string;
      context: Record<string, unknown>;
    }) => api<{ id: string; content: string }>('/api/documents/generate', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['documents'] }),
  });
}

interface UploadBody {
  fileName: string; mimeType: string; contentBase64: string;
  category?: string; entityType: string; entityId: string; tags?: string[];
}
function useUploadDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UploadBody) => api<{ id: string }>('/api/documents/upload', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['documents-search'] }),
  });
}

/* ---------------- Page ---------------- */
export function DocumentsPage() {
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('documents:write');
  const [tab, setTab] = useState('search');

  const templates = useDocTemplates();
  const documents = useDocuments('');
  const tplCount = templates.data?.templates.length ?? 0;
  const docCount = documents.data?.documents.length ?? 0;
  const docTypeCount = new Set((documents.data?.documents ?? []).map((d) => d.doc_type ?? 'other')).size;

  return (
    <div className={styles.page}>
      <PageHeader
        title="Document Workspace"
        description="Search every document across the portfolio, upload real files, and author reusable templates."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Documents' }]}
        actions={
          canWrite ? (
            <Button variant="primary" onClick={() => setTab('generate')} icon={<Sparkles size={16} />}>
              Generate document
            </Button>
          ) : (
            <span className={shared.cellSub}>read-only</span>
          )
        }
      />

      <div className={shared.kpiGrid}>
        <KpiCard
          label="Templates"
          value={formatNumber(tplCount)}
          hint="Reusable merge bodies"
          icon={<LayoutTemplate size={20} />}
          accent="var(--primary)"
          loading={templates.isLoading}
        />
        <KpiCard
          label="Documents"
          value={formatNumber(docCount)}
          hint="Across the portfolio"
          icon={<FileStack size={20} />}
          accent="var(--accent-violet)"
          loading={documents.isLoading}
        />
        <KpiCard
          label="Document types"
          value={formatNumber(docTypeCount)}
          hint="Distinct categories in use"
          icon={<FolderOpen size={20} />}
          accent="var(--accent-cyan)"
          loading={documents.isLoading}
        />
      </div>

      <Tabs
        tabs={[
          { id: 'search', label: 'Search & upload' },
          { id: 'templates', label: 'Templates' },
          { id: 'generate', label: 'Generate' },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'search' && <SearchTab canWrite={canWrite} />}
      {tab === 'templates' && <TemplatesTab canWrite={canWrite} />}
      {tab === 'generate' && <GenerateTab canWrite={canWrite} />}
    </div>
  );
}

/* ---------------- Search & upload tab ---------------- */
function SearchTab({ canWrite }: { canWrite: boolean }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [entityType, setEntityType] = useState('');
  const [tag, setTag] = useState('');
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const params: SearchParams = {
    q: q.trim() || undefined,
    category: category || undefined,
    entityType: entityType.trim() || undefined,
    tag: tag.trim() || undefined,
  };
  const { data, isLoading } = useSearchDocuments(params);
  const rows = data?.documents ?? [];

  const runDownload = async (row: SearchRow) => {
    setDownloadingId(row.id);
    try {
      const c = await api<DocContent>(`/api/documents/${row.id}/content`);
      downloadBase64(c.fileName, c.mimeType, c.contentBase64);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not download the document.');
    } finally {
      setDownloadingId(null);
    }
  };

  const columns: Column<SearchRow>[] = [
    {
      key: 'name',
      header: 'Name',
      sortValue: (d) => d.fileName ?? d.title,
      render: (d) => (
        <div>
          <span className={shared.cellMain}>{d.fileName ?? d.title}</span>
          {d.tags && d.tags.length > 0 && (
            <div className={styles.tagRow}>
              {d.tags.map((t) => <Badge key={t} color="slate" variant="outline">{t}</Badge>)}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'category',
      header: 'Category',
      sortValue: (d) => d.category ?? d.docType ?? '',
      render: (d) =>
        d.category ? <Badge color="indigo" variant="outline">{d.category}</Badge>
          : d.docType ? <Badge color="slate" variant="outline">{titleCase(d.docType)}</Badge>
            : '-',
    },
    { key: 'status', header: 'Status', sortValue: (d) => d.docStatus ?? '', render: (d) => <StatusPill status={d.docStatus} /> },
    { key: 'version', header: 'Version', align: 'right', sortValue: (d) => d.currentVersion ?? 0, render: (d) => (d.currentVersion ? `v${d.currentVersion}` : '-') },
    { key: 'created', header: 'Created', align: 'right', sortValue: (d) => d.createdAt, render: (d) => formatDate(d.createdAt) },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (d) => (
        <span className={styles.rowActions} onClick={(e) => e.stopPropagation()}>
          <Button size="sm" variant="ghost" icon={<Eye size={15} />} title="Preview" onClick={() => setPreviewId(d.id)} />
          <Button
            size="sm" variant="ghost" icon={<Download size={15} />} title="Download"
            loading={downloadingId === d.id} onClick={() => runDownload(d)}
          />
        </span>
      ),
    },
  ];

  return (
    <div className={shared.stack}>
      {canWrite && <UploadCard />}

      <Card padded={false}>
        <div className={`${shared.toolbar} ${styles.toolbarPad}`}>
          <div className={shared.filter}>
            <Search size={16} className={shared.filterLabel} aria-hidden />
            <Input
              className={shared.searchInput}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search file names, captured text, titles…"
              aria-label="Search documents"
            />
          </div>
          <div className={shared.filter}>
            <span className={shared.filterLabel}>Category</span>
            <Select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Filter by category">
              <option value="">All</option>
              {DOC_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </div>
          <div className={shared.filter}>
            <span className={shared.filterLabel}>Entity</span>
            <Input value={entityType} onChange={(e) => setEntityType(e.target.value)} placeholder="e.g. contract" aria-label="Filter by entity type" />
          </div>
          <div className={shared.filter}>
            <span className={shared.filterLabel}>Tag</span>
            <Input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="e.g. renewal" aria-label="Filter by tag" />
          </div>
          <div className={shared.spacer} />
          <span className={shared.cellSub}>{rows.length} result{rows.length === 1 ? '' : 's'}</span>
        </div>
        <Table
          columns={columns}
          rows={rows}
          loading={isLoading}
          rowKey={(d) => d.id}
          onRowClick={(d) => setPreviewId(d.id)}
          empty={<EmptyState title="No documents found" message="Adjust the search or filters, or upload a file above." icon={<Search size={16} />} />}
        />
      </Card>

      <DocumentPreviewModal docId={previewId} onClose={() => setPreviewId(null)} />
    </div>
  );
}

/* ---------------- General upload (to a chosen entity) ---------------- */
function UploadCard() {
  const toast = useToast();
  const upload = useUploadDocument();
  const [entityType, setEntityType] = useState('');
  const [entityId, setEntityId] = useState('');
  const [category, setCategory] = useState<string>(DOC_CATEGORIES[0]);
  const [tagsText, setTagsText] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const MAX_FILE_BYTES = 10 * 1024 * 1024;

  const process = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    if (!entityType.trim() || !entityId.trim()) {
      toast.error('Set a target entity type and ID first - every upload links to a record.');
      return;
    }
    const tags = tagsText.split(',').map((t) => t.trim()).filter(Boolean);
    setUploading(true);
    for (const file of Array.from(fileList)) {
      const mimeType = inferMimeType(file.name, file.type);
      if (mimeType === 'application/octet-stream') { toast.error(`"${file.name}" is not an allowed file type.`); continue; }
      if (file.size > MAX_FILE_BYTES) { toast.error(`"${file.name}" exceeds the 10 MB limit.`); continue; }
      try {
        const contentBase64 = await readFileAsBase64(file);
        await upload.mutateAsync({
          fileName: file.name,
          mimeType,
          contentBase64,
          category,
          entityType: entityType.trim(),
          entityId: entityId.trim(),
          tags: tags.length ? tags : undefined,
        });
        toast.success(`Uploaded ${file.name}`);
      } catch (err) {
        toast.error(err instanceof ApiError ? `${file.name}: ${err.message}` : `Could not upload ${file.name}.`);
      }
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <Card>
      <CardHeader title="Upload a file" subtitle="Every upload links to a target record; the backend has no unlinked store." />
      <FormSection title="Target & classification">
        <FormField label="Entity type" required hint="e.g. contract, party, claim">
          <Input value={entityType} onChange={(e) => setEntityType(e.target.value)} placeholder="e.g. contract" />
        </FormField>
        <FormField label="Entity ID (UUID)" required>
          <Input value={entityId} onChange={(e) => setEntityId(e.target.value)} placeholder="e.g. 5f0e…" />
        </FormField>
        <FormField label="Category">
          <Select value={category} onChange={(e) => setCategory(e.target.value)}>
            {DOC_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        </FormField>
        <FormField label="Tags (comma-separated)">
          <Input value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder="e.g. 2026, renewal" />
        </FormField>
      </FormSection>
      <div className={styles.uploadRow}>
        <Button
          variant="secondary"
          icon={<Upload size={15} />}
          loading={uploading}
          onClick={() => fileRef.current?.click()}
        >
          Choose files & upload
        </Button>
        <span className={shared.cellSub}>{ALLOWED_LABEL}</span>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept={ACCEPT_EXTENSIONS}
          style={{ display: 'none' }}
          onChange={(e) => process(e.target.files)}
        />
      </div>
    </Card>
  );
}

/* ---------------- Templates tab ---------------- */
function TemplatesTab({ canWrite }: { canWrite: boolean }) {
  const { data, isLoading } = useDocTemplates();
  const [showNew, setShowNew] = useState(false);

  const columns: Column<DocTemplate>[] = [
    { key: 'key', header: 'Key', sortValue: (t) => t.key, render: (t) => <span className={shared.cellRef}>{t.key}</span> },
    { key: 'name', header: 'Name', sortValue: (t) => t.name, render: (t) => <span className={shared.cellMain}>{t.name}</span> },
    { key: 'docType', header: 'Type', sortValue: (t) => t.doc_type ?? '', render: (t) => titleCase(t.doc_type) || '-' },
    { key: 'version', header: 'Version', align: 'right', sortValue: (t) => t.version ?? 0, render: (t) => t.version ?? '-' },
  ];

  return (
    <>
      <Card padded={false}>
        <div className={styles.cardHead}>
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
          empty={<EmptyState title="No templates" message="Create a template to start generating documents." icon={<FileText size={16} />} />}
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
      <form onSubmit={submit} className={styles.form}>
        <div className={shared.grid2}>
          <TextField label="Key" value={key} onChange={setKey} required placeholder="e.g. cover_note" />
          <TextField label="Name" value={name} onChange={setName} required placeholder="e.g. Cover note" />
        </div>
        <FormField label="Document type">
          <Select value={docType} onChange={(e) => setDocType(e.target.value)}>
            <option value="">Unspecified</option>
            {DOC_TYPES.map((d) => <option key={d} value={d}>{titleCase(d)}</option>)}
          </Select>
        </FormField>
        <FormField label="Body" required hint="Use {{ dotted.path }} placeholders - e.g. {{ contract.reference }} - resolved from the generation context.">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={10}
            placeholder={'Cover note for {{ contract.reference }}\nCedent: {{ cedent.legalName }}\nPeriod: {{ contract.periodStart }}'}
            className={styles.mono}
          />
        </FormField>
        {error && <p className={styles.error} role="alert">{error}</p>}
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
  const [docType, setDocType] = useState('');
  const [entityType, setEntityType] = useState('');
  const [entityId, setEntityId] = useState('');
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
      const res = await generate.mutateAsync({
        templateKey,
        title: title.trim(),
        docType: docType || undefined,
        entityType: entityType.trim() || undefined,
        entityId: entityId.trim() || undefined,
        context: ctx,
      });
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
          icon={<Lock size={16} />}
        />
      </Card>
    );
  }

  return (
    <div className={shared.cols}>
      <Card>
        <CardHeader title="Generate a document" subtitle="Merge a template body with a context object." />
        <form onSubmit={submit} className={styles.form}>
          <FormSection title="Template & title">
            <div style={{ gridColumn: '1 / -1' }}>
              <FormField label="Template" required>
                <Select value={templateKey} onChange={(e) => setTemplateKey(e.target.value)}>
                  <option value="">Select a template…</option>
                  {tpls.map((t) => <option key={t.id} value={t.key}>{t.name} ({t.key})</option>)}
                </Select>
              </FormField>
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <TextField label="Title" value={title} onChange={setTitle} required placeholder="e.g. Cover note - NAP QS 2026" />
            </div>
            <FormField label="Document type" hint="Overrides the template's default type">
              <Select value={docType} onChange={(e) => setDocType(e.target.value)}>
                <option value="">Use template default</option>
                {DOC_TYPES.map((d) => <option key={d} value={d}>{titleCase(d)}</option>)}
              </Select>
            </FormField>
          </FormSection>

          <FormSection title="Entity link" description="Optionally attach the document to a source record so it surfaces on that entity.">
            <FormField label="Entity type" hint="Optional, e.g. contract, party, claim">
              <Input value={entityType} onChange={(e) => setEntityType(e.target.value)} placeholder="e.g. contract" />
            </FormField>
            <FormField label="Entity ID" hint="Optional (UUID)">
              <Input value={entityId} onChange={(e) => setEntityId(e.target.value)} placeholder="e.g. contract id" />
            </FormField>
          </FormSection>

          <FormSection title="Merge context">
            <div style={{ gridColumn: '1 / -1' }}>
              <FormField label="Context (JSON)" hint="Object whose keys back the {{ dotted.path }} placeholders.">
                <Textarea
                  value={context}
                  onChange={(e) => setContext(e.target.value)}
                  rows={10}
                  spellCheck={false}
                  className={styles.mono}
                  placeholder={'{\n  "contract": { "reference": "C-0001" }\n}'}
                />
              </FormField>
            </div>
          </FormSection>
          {error && <p className={styles.error} role="alert">{error}</p>}
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
          <pre className={styles.preview}>
            {rendered}
          </pre>
        ) : (
          <EmptyState title="Nothing generated yet" message="Pick a template and run the merge to preview output." icon={<Clock size={16} />} />
        )}
      </Card>
    </div>
  );
}
