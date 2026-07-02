/**
 * DocumentsPanel - a reusable, self-contained documents surface any business
 * object can embed (`<DocumentsPanel entityType="contract" entityId={id} />`).
 *
 * It is built strictly on what the documents API (server/src/modules/documents.ts)
 * actually supports:
 *   - GET  /api/documents?entityType&entityId   list docs linked to this entity
 *   - GET  /api/documents/:id                    fetch rendered content (preview/download)
 *   - GET  /api/documents/templates              templates for the "attach" flow
 *   - POST /api/documents/generate               create an entity-linked document
 * Documents link to an entity via the `entity_type` / `entity_id` columns.
 *
 * WIRED: list, preview, download (client-side blob of the rendered content, since
 * the API has no binary download endpoint), and attach-via-template with a chosen
 * category (docType). HONESTLY STUBBED: raw binary file upload / OCR / versioning -
 * the API stores template-generated documents, not uploaded bytes, so those are
 * surfaced as disabled / "not yet available" rather than faked.
 *
 * All query/mutation hooks are LOCAL to this file by design.
 */
import { useState, useRef, type DragEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { useToast } from './Toast';
import { Card, CardHeader } from './Card';
import { Table, type Column, EmptyState } from './Table';
import { StatusPill, Badge } from './Badge';
import { Button } from './Button';
import { Modal } from './Modal';
import { FormField, FormSection, Select, Textarea, TextField } from './Form';
import { formatDate, titleCase } from '../lib/format';
import { api, qs, ApiError } from '../lib/api';
import { FileText, Upload, Download, Eye, Paperclip, Lock, Info } from 'lucide-react';
import styles from './DocumentsPanel.module.css';

/**
 * Default categories. The API has no dedicated document-category code list, so
 * (mirroring DocumentsPage) we use a sensible default set for the docType field.
 */
const DOC_TYPES = ['SLIP', 'COVER_NOTE', 'ENDORSEMENT', 'STATEMENT', 'LETTER', 'CONTRACT', 'CORRESPONDENCE', 'OTHER'];

const DEFAULT_MAX_ATTACHMENTS = 10;

/* ---------------- Types (mirror the documents API response shapes) ---------------- */
interface DocRow {
  id: string;
  templateKey: string | null;
  title: string;
  docType: string | null;
  entityType: string | null;
  entityId: string | null;
  status: string;
  createdAt: string;
}
interface DocDetail extends DocRow {
  content: string;
  mergeContext: unknown;
}
interface TemplateRow {
  id: string;
  key: string;
  name: string;
  docType: string | null;
}

/* ---------------- Local data hooks (kept local by design) ---------------- */
function useEntityDocuments(entityType: string, entityId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['entity-documents', entityType, entityId],
    queryFn: () => api<{ documents: DocRow[] }>(`/api/documents${qs({ entityType, entityId })}`),
    enabled: enabled && !!entityType && !!entityId,
  });
}

function useTemplates(enabled: boolean) {
  return useQuery({
    queryKey: ['doc-templates'],
    queryFn: () => api<{ templates: TemplateRow[] }>('/api/documents/templates'),
    enabled,
  });
}

function useDocumentDetail(id: string | null) {
  return useQuery({
    queryKey: ['document', id],
    queryFn: () => api<DocDetail>(`/api/documents/${id}`),
    enabled: !!id,
  });
}

function useGenerateDocument(entityType: string, entityId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      templateKey: string; title: string; docType?: string; context: Record<string, unknown>;
    }) =>
      api<{ id: string; content: string }>('/api/documents/generate', {
        body: { ...body, entityType, entityId },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['entity-documents', entityType, entityId] }),
  });
}

/** Fetch a document's rendered content and trigger a client-side text download. */
async function downloadDocument(id: string, title: string): Promise<void> {
  const doc = await api<DocDetail>(`/api/documents/${id}`);
  const blob = new Blob([doc.content ?? ''], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(title || 'document').replace(/[^\w.-]+/g, '_')}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ---------------- Panel ---------------- */
interface DocumentsPanelProps {
  entityType: string;
  entityId: string;
  /** Honestly-surfaced cap on linked documents. */
  maxAttachments?: number;
  /** Optional heading override. */
  heading?: string;
}

export function DocumentsPanel({
  entityType,
  entityId,
  maxAttachments = DEFAULT_MAX_ATTACHMENTS,
  heading = 'Documents',
}: DocumentsPanelProps) {
  const { hasPermission } = useAuth();
  const toast = useToast();
  const canRead = hasPermission('documents:read');
  const canWrite = hasPermission('documents:write');

  const { data, isLoading } = useEntityDocuments(entityType, entityId, canRead);
  const docs = data?.documents ?? [];
  const count = docs.length;
  const atLimit = count >= maxAttachments;

  const [attachOpen, setAttachOpen] = useState(false);
  const [seedTitle, setSeedTitle] = useState('');
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const openAttach = (title = '') => {
    if (!canWrite || atLimit) return;
    setSeedTitle(title);
    setAttachOpen(true);
  };

  // The API stores template-generated documents, not raw file bytes; a picked /
  // dropped file therefore only seeds the title - we say so plainly in the UI.
  const onFilePicked = (files: FileList | null) => {
    const name = files?.[0]?.name;
    if (name) {
      openAttach(name.replace(/\.[^.]+$/, ''));
      toast.push('The file name seeds the title - binary upload is not stored by the API yet.', 'info');
    } else {
      openAttach();
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    if (!canWrite || atLimit) return;
    onFilePicked(e.dataTransfer.files);
  };

  const runDownload = async (row: DocRow) => {
    setDownloadingId(row.id);
    try {
      await downloadDocument(row.id, row.title);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not download the document.');
    } finally {
      setDownloadingId(null);
    }
  };

  const columns: Column<DocRow>[] = [
    {
      key: 'title',
      header: 'Name',
      sortValue: (d) => d.title,
      render: (d) => (
        <div>
          <div className={styles.dzText}>{d.title}</div>
          {d.templateKey && <div className={styles.ref}>from {d.templateKey}</div>}
        </div>
      ),
    },
    {
      key: 'docType',
      header: 'Category',
      sortValue: (d) => d.docType ?? '',
      render: (d) => (d.docType ? <Badge color="indigo" variant="outline">{titleCase(d.docType)}</Badge> : '-'),
    },
    { key: 'status', header: 'Status', sortValue: (d) => d.status, render: (d) => <StatusPill status={d.status} /> },
    {
      key: 'created',
      header: 'Uploaded',
      align: 'right',
      sortValue: (d) => d.createdAt,
      render: (d) => formatDate(d.createdAt),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (d) => (
        <span className={styles.rowActions} onClick={(e) => e.stopPropagation()}>
          <Button size="sm" variant="ghost" icon={<Eye size={15} />} onClick={() => setPreviewId(d.id)}>
            Preview
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<Download size={15} />}
            loading={downloadingId === d.id}
            onClick={() => runDownload(d)}
          >
            Download
          </Button>
        </span>
      ),
    },
  ];

  if (!canRead) {
    return (
      <Card>
        <EmptyState
          title="No access to documents"
          message="You need the documents:read permission to view documents for this record."
          icon={<Lock size={16} />}
        />
      </Card>
    );
  }

  return (
    <Card padded={false}>
      <div style={{ padding: 'var(--space-4) var(--space-4) 0' }}>
        <CardHeader
          title={heading}
          subtitle="Documents linked to this record. Generated from reusable templates and cross-linked by entity."
          actions={
            <span className={`${styles.limitNote} ${atLimit ? styles.limitReached : ''}`}>
              {count} / {maxAttachments}
            </span>
          }
        />
      </div>

      <div className={styles.panel} style={{ padding: 'var(--space-4)' }}>
        {canWrite ? (
          <div
            className={`${styles.dropzone} ${dragOver ? styles.dropzoneOver : ''} ${atLimit ? styles.dropzoneDisabled : ''}`}
            onClick={() => !atLimit && fileRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); if (!atLimit) setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            role="button"
            tabIndex={0}
            aria-disabled={atLimit}
            onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !atLimit) fileRef.current?.click(); }}
          >
            <Upload size={22} className={styles.dzIcon} aria-hidden />
            <span className={styles.dzText}>
              {atLimit ? 'Attachment limit reached' : 'Drag a file here or click to attach a document'}
            </span>
            <span className={styles.dzHint}>
              {atLimit
                ? `This record already has ${maxAttachments} documents (the configured maximum).`
                : 'The API stores template-generated documents, not raw file bytes - a picked file seeds the title, then you choose a template and category to generate the linked document.'}
            </span>
            <input
              ref={fileRef}
              type="file"
              className={styles.hiddenInput}
              onChange={(e) => onFilePicked(e.target.files)}
            />
          </div>
        ) : (
          <div className={styles.stub}>
            <Info size={14} aria-hidden />
            Read-only - the documents:write permission is required to attach documents.
          </div>
        )}

        {canWrite && (
          <div className={styles.toolbar}>
            <Button
              size="sm"
              variant="secondary"
              icon={<Paperclip size={15} />}
              onClick={() => openAttach()}
              disabled={atLimit}
            >
              Attach document
            </Button>
            <span className={styles.spacer} />
          </div>
        )}

        <Table
          columns={columns}
          rows={docs}
          loading={isLoading}
          rowKey={(d) => d.id}
          onRowClick={(d) => setPreviewId(d.id)}
          empty={
            <EmptyState
              title="No documents yet"
              message="Attach a document to link it to this record."
              icon={<FileText size={16} />}
            />
          }
          skeletonRows={3}
        />

        <div className={styles.stub}>
          <Info size={14} aria-hidden />
          Version history and OCR are not yet available - the documents API does not expose those endpoints.
        </div>
      </div>

      <AttachModal
        open={attachOpen}
        onClose={() => setAttachOpen(false)}
        entityType={entityType}
        entityId={entityId}
        seedTitle={seedTitle}
      />
      <PreviewModal id={previewId} onClose={() => setPreviewId(null)} />
    </Card>
  );
}

/* ---------------- Attach (generate-from-template) modal ---------------- */
function AttachModal({
  open, onClose, entityType, entityId, seedTitle,
}: {
  open: boolean; onClose: () => void; entityType: string; entityId: string; seedTitle: string;
}) {
  const toast = useToast();
  const { data: templates, isLoading: templatesLoading } = useTemplates(open);
  const generate = useGenerateDocument(entityType, entityId);
  const [templateKey, setTemplateKey] = useState('');
  const [title, setTitle] = useState('');
  const [docType, setDocType] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Sync the seeded title in when the modal opens with a dropped file name.
  const [lastSeed, setLastSeed] = useState<string | null>(null);
  if (open && seedTitle !== lastSeed) {
    setLastSeed(seedTitle);
    if (seedTitle) setTitle(seedTitle);
  }

  const tpls = templates?.templates ?? [];

  const reset = () => {
    setTemplateKey(''); setTitle(''); setDocType(''); setNote(''); setError(null); setLastSeed(null);
  };
  const close = () => { reset(); onClose(); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!templateKey) { setError('Pick a template.'); return; }
    if (!title.trim()) { setError('A title is required.'); return; }
    try {
      await generate.mutateAsync({
        templateKey,
        title: title.trim(),
        docType: docType || undefined,
        context: note.trim() ? { note: note.trim() } : {},
      });
      toast.success(`Document “${title.trim()}” attached`);
      close();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not attach the document.');
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Attach document"
      description="Generate a document from a template and link it to this record."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={submit} loading={generate.isPending} disabled={!templateKey || !title.trim()}>
            Attach document
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className={styles.form}>
        {tpls.length === 0 && !templatesLoading ? (
          <div className={styles.stub}>
            <Info size={14} aria-hidden />
            No templates exist yet. Create one on the Documents page before attaching.
          </div>
        ) : null}
        <FormSection title="Template & category">
          <div style={{ gridColumn: '1 / -1' }}>
            <FormField label="Template" required>
              <Select value={templateKey} onChange={(e) => setTemplateKey(e.target.value)} disabled={templatesLoading}>
                <option value="">{templatesLoading ? 'Loading templates…' : 'Select a template…'}</option>
                {tpls.map((t) => <option key={t.id} value={t.key}>{t.name} ({t.key})</option>)}
              </Select>
            </FormField>
          </div>
          <FormField label="Category" hint="Overrides the template's default type">
            <Select value={docType} onChange={(e) => setDocType(e.target.value)}>
              <option value="">Use template default</option>
              {DOC_TYPES.map((d) => <option key={d} value={d}>{titleCase(d)}</option>)}
            </Select>
          </FormField>
        </FormSection>

        <div style={{ gridColumn: '1 / -1' }}>
          <TextField label="Title" value={title} onChange={setTitle} required placeholder="e.g. Cover note" />
        </div>

        <FormField label="Note" hint="Optional. Merged into the template as {{ note }}.">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="Optional context for the document" />
        </FormField>

        {error && <p className={styles.error} role="alert">{error}</p>}
      </form>
    </Modal>
  );
}

/* ---------------- Preview modal ---------------- */
function PreviewModal({ id, onClose }: { id: string | null; onClose: () => void }) {
  const toast = useToast();
  const { data, isLoading, isError } = useDocumentDetail(id);

  const download = async () => {
    if (!data) return;
    try {
      await downloadDocument(data.id, data.title);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not download the document.');
    }
  };

  return (
    <Modal
      open={!!id}
      onClose={onClose}
      title={data?.title ?? 'Document'}
      description={data ? `${titleCase(data.docType) || 'Document'} · ${formatDate(data.createdAt)}` : undefined}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          {data && <Button variant="secondary" icon={<Download size={15} />} onClick={download}>Download</Button>}
        </>
      }
    >
      {isLoading && <p className={styles.sub}>Loading…</p>}
      {isError && <p className={styles.error} role="alert">Could not load the document.</p>}
      {data && <pre className={styles.preview}>{data.content}</pre>}
    </Modal>
  );
}
