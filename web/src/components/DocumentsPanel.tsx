/**
 * DocumentsPanel - a full Document Workspace any business object embeds
 * (`<DocumentsPanel entityType="contract" entityId={id} />`). The three existing
 * embeds (treaty, claim, party detail) auto-upgrade because the props are
 * unchanged.
 *
 * Built strictly on the real Document Engine API (server/src/modules/documents.ts):
 *   GET    /api/documents?entityType&entityId     list metadata linked to entity
 *   GET    /api/documents/config                  per-record attachment cap
 *   POST   /api/documents/upload                  real base64 file upload
 *   POST   /api/documents/:id/versions            add a new version
 *   GET    /api/documents/:id/versions            version history
 *   GET    /api/documents/:id/content?version=    binary payload (preview/download)
 *   GET/POST/DELETE /api/documents/:id/links      cross-entity links
 *   POST   /api/documents/:id/transition          approval workflow
 *   POST   /api/documents/:id/extract             AI field extraction
 *
 * HONEST LIMITS (labelled, never faked):
 *   - docx / xlsx / zip / tiff have no in-browser preview -> "download to view".
 *   - There is no restore endpoint -> version timeline offers "download previous"
 *     and says restore is not yet available.
 *   - There is no endpoint to write extracted fields back onto the record ->
 *     extraction is stored on the document for reference only.
 *
 * All query/mutation hooks are LOCAL to this file by design (nothing added to
 * lib/queries.ts).
 */
import { useState, useRef, type DragEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { useToast } from './Toast';
import { Card, CardHeader } from './Card';
import { Table, type Column, EmptyState } from './Table';
import { StatusPill, Badge } from './Badge';
import { Button } from './Button';
import { Modal, ConfirmDialog } from './Modal';
import { Drawer } from './Drawer';
import { Input, Select, TextField } from './Form';
import { formatDate, formatDateTime, titleCase } from '../lib/format';
import { api, qs, ApiError } from '../lib/api';
import {
  FileText, Upload, Download, Eye, Lock, Info, History, Link2, Sparkles, Trash2,
} from 'lucide-react';
import {
  DOC_CATEGORIES, ACCEPT_EXTENSIONS, ALLOWED_LABEL, inferMimeType, readFileAsBase64,
  downloadBase64, nextDocStatuses, DocumentPreviewModal, ConfidenceBadge, type DocContent,
} from './documentShared';
import styles from './DocumentsPanel.module.css';

const DEFAULT_MAX_ATTACHMENTS = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/* ---------------- Types (mirror the documents API response shapes) ---------------- */
interface DocRow {
  id: string;
  templateKey: string | null;
  title: string;
  docType: string | null;
  entityType: string | null;
  entityId: string | null;
  status: string;
  docStatus: string | null;
  category: string | null;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  currentVersion: number | null;
  tags: string[] | null;
  createdAt: string;
}
interface VersionRow {
  version: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  changeSummary: string | null;
  uploadedBy: string | null;
  createdAt: string;
}
interface LinkRow {
  entityType: string;
  entityId: string;
  createdBy: string | null;
  createdAt: string;
}
interface ExtractionField { value: string | null; confidence: number }
interface Extraction {
  llmUsed: boolean;
  note: string;
  fields: Record<string, ExtractionField>;
}

/* ---------------- Local data hooks (kept local by design) ---------------- */
function useEntityDocuments(entityType: string, entityId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['entity-documents', entityType, entityId],
    queryFn: () => api<{ documents: DocRow[] }>(`/api/documents${qs({ entityType, entityId })}`),
    enabled: enabled && !!entityType && !!entityId,
  });
}

function useDocConfig(enabled: boolean) {
  return useQuery({
    queryKey: ['documents-config'],
    queryFn: () => api<{ maxAttachmentsPerRecord: number }>('/api/documents/config'),
    enabled,
  });
}

interface UploadBody {
  fileName: string; mimeType: string; contentBase64: string;
  category?: string; tags?: string[]; changeSummary?: string;
}
function useUploadDocument(entityType: string, entityId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UploadBody) =>
      api<{ id: string }>('/api/documents/upload', { body: { ...body, entityType, entityId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['entity-documents', entityType, entityId] }),
  });
}

function useVersions(docId: string | null) {
  return useQuery({
    queryKey: ['document-versions', docId],
    queryFn: () => api<{ versions: VersionRow[] }>(`/api/documents/${docId}/versions`),
    enabled: !!docId,
  });
}

function useAddVersion(entityType: string, entityId: string, docId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { fileName: string; mimeType: string; contentBase64: string; changeSummary: string }) =>
      api<{ id: string; version: number }>(`/api/documents/${docId}/versions`, { body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['document-versions', docId] });
      qc.invalidateQueries({ queryKey: ['entity-documents', entityType, entityId] });
    },
  });
}

function useLinks(docId: string | null) {
  return useQuery({
    queryKey: ['document-links', docId],
    queryFn: () => api<{ links: LinkRow[] }>(`/api/documents/${docId}/links`),
    enabled: !!docId,
  });
}

function useMutateLink(entityType: string, entityId: string, docId: string | null) {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['document-links', docId] });
    qc.invalidateQueries({ queryKey: ['entity-documents', entityType, entityId] });
  };
  const add = useMutation({
    mutationFn: (body: { entityType: string; entityId: string }) =>
      api(`/api/documents/${docId}/links`, { body }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (body: { entityType: string; entityId: string }) =>
      api(`/api/documents/${docId}/links`, { method: 'DELETE', body }),
    onSuccess: invalidate,
  });
  return { add, remove };
}

function useTransition(entityType: string, entityId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, to }: { id: string; to: string }) =>
      api<{ id: string; from: string; to: string }>(`/api/documents/${id}/transition`, { body: { to } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['entity-documents', entityType, entityId] }),
  });
}

function useExtract() {
  return useMutation({
    mutationFn: (id: string) => api<{ id: string; extraction: Extraction }>(`/api/documents/${id}/extract`, { body: {} }),
  });
}

/** Fetch a document's binary content and trigger a download (head or a version). */
async function downloadDoc(id: string, version?: number): Promise<void> {
  const c = await api<DocContent>(`/api/documents/${id}/content${version ? `?version=${version}` : ''}`);
  downloadBase64(c.fileName, c.mimeType, c.contentBase64);
}

/* ---------------- Panel ---------------- */
interface DocumentsPanelProps {
  entityType: string;
  entityId: string;
  /** Fallback cap when the config endpoint is unavailable. */
  maxAttachments?: number;
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
  const { data: config } = useDocConfig(canRead);
  const upload = useUploadDocument(entityType, entityId);
  const transition = useTransition(entityType, entityId);

  const docs = data?.documents ?? [];
  const count = docs.length;
  const max = config?.maxAttachmentsPerRecord ?? maxAttachments;
  const atLimit = count >= max;

  const [category, setCategory] = useState<string>(DOC_CATEGORIES[0]);
  const [tagsText, setTagsText] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [previewId, setPreviewId] = useState<string | null>(null);
  const [versionsDoc, setVersionsDoc] = useState<DocRow | null>(null);
  const [linksDoc, setLinksDoc] = useState<DocRow | null>(null);
  const [extractDoc, setExtractDoc] = useState<DocRow | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [pendingTx, setPendingTx] = useState<{ id: string; from: string; to: string } | null>(null);

  const parseTags = () =>
    tagsText.split(',').map((t) => t.trim()).filter(Boolean);

  const processFiles = async (fileList: FileList | null) => {
    if (!canWrite || !fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    const remaining = Math.max(0, max - count);
    if (remaining <= 0) {
      toast.error(`Attachment limit reached (${max}). Remove or archive a document first.`);
      return;
    }
    const tags = parseTags();
    setUploading(true);
    let done = 0;
    for (const file of files) {
      if (done >= remaining) {
        toast.push(`Only ${remaining} more file(s) allowed on this record; "${file.name}" skipped.`, 'warning');
        continue;
      }
      const mimeType = inferMimeType(file.name, file.type);
      if (mimeType === 'application/octet-stream') {
        toast.error(`"${file.name}" is not an allowed file type.`);
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        toast.error(`"${file.name}" exceeds the 10 MB limit.`);
        continue;
      }
      try {
        const contentBase64 = await readFileAsBase64(file);
        await upload.mutateAsync({
          fileName: file.name,
          mimeType,
          contentBase64,
          category,
          tags: tags.length ? tags : undefined,
        });
        done += 1;
        toast.success(`Uploaded ${file.name}`);
      } catch (err) {
        toast.error(err instanceof ApiError ? `${file.name}: ${err.message}` : `Could not upload ${file.name}.`);
      }
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    void processFiles(e.dataTransfer.files);
  };

  const runDownload = async (row: DocRow) => {
    setDownloadingId(row.id);
    try {
      await downloadDoc(row.id);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not download the document.');
    } finally {
      setDownloadingId(null);
    }
  };

  const doTransition = async () => {
    if (!pendingTx) return;
    try {
      await transition.mutateAsync({ id: pendingTx.id, to: pendingTx.to });
      toast.success(`Moved to ${titleCase(pendingTx.to)}`);
      setPendingTx(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not change the status.');
      setPendingTx(null);
    }
  };

  const columns: Column<DocRow>[] = [
    {
      key: 'name',
      header: 'Name',
      sortValue: (d) => d.fileName ?? d.title,
      render: (d) => (
        <div>
          <div className={styles.fileName}>{d.fileName ?? d.title}</div>
          {d.templateKey && <div className={styles.ref}>from {d.templateKey}</div>}
          {d.tags && d.tags.length > 0 && (
            <div className={styles.tagChips}>
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
    {
      key: 'status',
      header: 'Status',
      sortValue: (d) => d.docStatus ?? d.status,
      render: (d) => <StatusPill status={d.docStatus ?? d.status} />,
    },
    {
      key: 'version',
      header: 'Version',
      align: 'right',
      sortValue: (d) => d.currentVersion ?? 0,
      render: (d) => (d.currentVersion ? `v${d.currentVersion}` : '-'),
    },
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
      render: (d) => {
        const nexts = canWrite ? nextDocStatuses(d.docStatus) : [];
        return (
          <span className={styles.rowActions} onClick={(e) => e.stopPropagation()}>
            <Button size="sm" variant="ghost" icon={<Eye size={15} />} title="Preview" onClick={() => setPreviewId(d.id)} />
            <Button
              size="sm" variant="ghost" icon={<Download size={15} />} title="Download"
              loading={downloadingId === d.id} onClick={() => runDownload(d)}
            />
            <Button size="sm" variant="ghost" icon={<History size={15} />} title="Versions" onClick={() => setVersionsDoc(d)} />
            <Button size="sm" variant="ghost" icon={<Link2 size={15} />} title="Links" onClick={() => setLinksDoc(d)} />
            {canWrite && (
              <Button size="sm" variant="ghost" icon={<Sparkles size={15} />} title="Extract fields (AI)" onClick={() => setExtractDoc(d)} />
            )}
            {nexts.map((to) => (
              <Button
                key={to}
                size="sm"
                variant="subtle"
                onClick={() => setPendingTx({ id: d.id, from: d.docStatus!, to })}
              >
                → {titleCase(to)}
              </Button>
            ))}
          </span>
        );
      },
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
          subtitle="Real files with versioning, approval workflow, AI extraction and cross-entity links."
          actions={
            <span className={`${styles.limitNote} ${atLimit ? styles.limitReached : ''}`}>
              {count} / {max}
            </span>
          }
        />
      </div>

      <div className={styles.panel} style={{ padding: 'var(--space-4)' }}>
        {canWrite ? (
          <>
            <div className={styles.catBar}>
              <div className={styles.catField}>
                <span className={styles.catLabel}>Category</span>
                <Select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Upload category">
                  {DOC_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </Select>
              </div>
              <div className={styles.catField}>
                <span className={styles.catLabel}>Tags (comma-separated)</span>
                <Input
                  value={tagsText}
                  onChange={(e) => setTagsText(e.target.value)}
                  placeholder="e.g. 2026, renewal"
                  aria-label="Upload tags"
                />
              </div>
            </div>

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
                {uploading ? 'Uploading…' : atLimit ? 'Attachment limit reached' : 'Drag files here or click to upload'}
              </span>
              <span className={styles.dzHint}>
                {atLimit
                  ? `This record already has ${max} documents (the configured maximum).`
                  : `Multiple files supported. ${ALLOWED_LABEL}.`}
              </span>
              <input
                ref={fileRef}
                type="file"
                multiple
                accept={ACCEPT_EXTENSIONS}
                className={styles.hiddenInput}
                onChange={(e) => processFiles(e.target.files)}
              />
            </div>
          </>
        ) : (
          <div className={styles.stub}>
            <Info size={14} aria-hidden />
            Read-only - the documents:write permission is required to upload or change documents.
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
              message="Upload a file to link it to this record."
              icon={<FileText size={16} />}
            />
          }
          skeletonRows={3}
        />
      </div>

      <DocumentPreviewModal docId={previewId} onClose={() => setPreviewId(null)} />

      <VersionsDrawer
        doc={versionsDoc}
        entityType={entityType}
        entityId={entityId}
        canWrite={canWrite}
        onClose={() => setVersionsDoc(null)}
      />

      <LinksDrawer
        doc={linksDoc}
        entityType={entityType}
        entityId={entityId}
        canWrite={canWrite}
        onClose={() => setLinksDoc(null)}
      />

      <ExtractModal doc={extractDoc} canWrite={canWrite} onClose={() => setExtractDoc(null)} />

      <ConfirmDialog
        open={!!pendingTx}
        onClose={() => setPendingTx(null)}
        onConfirm={doTransition}
        title="Change document status"
        message={pendingTx ? `Move this document from ${titleCase(pendingTx.from)} to ${titleCase(pendingTx.to)}?` : ''}
        confirmLabel={pendingTx ? `Move to ${titleCase(pendingTx.to)}` : 'Confirm'}
        loading={transition.isPending}
      />
    </Card>
  );
}

/* ---------------- Versions timeline drawer ---------------- */
function VersionsDrawer({
  doc, entityType, entityId, canWrite, onClose,
}: {
  doc: DocRow | null; entityType: string; entityId: string; canWrite: boolean; onClose: () => void;
}) {
  const toast = useToast();
  const { data, isLoading } = useVersions(doc?.id ?? null);
  const addVersion = useAddVersion(entityType, entityId, doc?.id ?? null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [summary, setSummary] = useState('');
  const [previewVersion, setPreviewVersion] = useState<number | null>(null);
  const versions = data?.versions ?? [];

  const onPickVersionFile = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file || !doc) return;
    if (!summary.trim()) { toast.error('Describe the change before uploading a new version.'); return; }
    const mimeType = inferMimeType(file.name, file.type);
    if (mimeType === 'application/octet-stream') { toast.error('Not an allowed file type.'); return; }
    if (file.size > MAX_FILE_BYTES) { toast.error('File exceeds the 10 MB limit.'); return; }
    try {
      const contentBase64 = await readFileAsBase64(file);
      const res = await addVersion.mutateAsync({ fileName: file.name, mimeType, contentBase64, changeSummary: summary.trim() });
      toast.success(`Uploaded version ${res.version}`);
      setSummary('');
      if (fileRef.current) fileRef.current.value = '';
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not upload the new version.');
    }
  };

  const downloadVersion = async (v: number) => {
    if (!doc) return;
    try {
      await downloadDoc(doc.id, v);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not download that version.');
    }
  };

  return (
    <Drawer
      open={!!doc}
      onClose={onClose}
      title="Version history"
      subtitle={doc?.fileName ?? doc?.title}
      width={480}
    >
      <div className={styles.sectionBlock}>
        {canWrite && (
          <div className={styles.sectionBlock}>
            <p className={styles.sectionTitle}>Upload a new version</p>
            <TextField label="Change summary" value={summary} onChange={setSummary} placeholder="What changed in this version?" required />
            <div>
              <Button
                variant="secondary"
                icon={<Upload size={15} />}
                loading={addVersion.isPending}
                onClick={() => fileRef.current?.click()}
              >
                Choose file & upload
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept={ACCEPT_EXTENSIONS}
                className={styles.hiddenInput}
                onChange={(e) => onPickVersionFile(e.target.files)}
              />
            </div>
            <div className={styles.stub}>
              <Info size={14} aria-hidden />
              Restore is not yet available - the API has no restore endpoint. Download a previous version instead, then re-upload it as a new version.
            </div>
          </div>
        )}

        <div className={styles.versionList}>
          {isLoading && <p className={styles.sub}>Loading versions…</p>}
          {!isLoading && versions.length === 0 && <p className={styles.sub}>No versions recorded.</p>}
          {versions.map((v) => (
            <div key={v.version} className={styles.versionItem}>
              <div>
                <div className={styles.versionHead}>
                  <Badge color="indigo" variant="soft">v{v.version}</Badge>
                  <span>{v.fileName}</span>
                </div>
                {v.changeSummary && <p className={styles.versionSummary}>{v.changeSummary}</p>}
                <p className={styles.versionMeta}>
                  {formatDateTime(v.createdAt)}{v.uploadedBy ? ' · uploaded by user' : ''}
                </p>
              </div>
              <div className={styles.versionActions}>
                <Button size="sm" variant="ghost" icon={<Eye size={15} />} title="Preview version" onClick={() => setPreviewVersion(v.version)} />
                <Button size="sm" variant="ghost" icon={<Download size={15} />} title="Download version" onClick={() => downloadVersion(v.version)} />
              </div>
            </div>
          ))}
        </div>
      </div>

      <DocumentPreviewModal
        docId={previewVersion != null ? (doc?.id ?? null) : null}
        version={previewVersion}
        label={doc?.fileName ?? doc?.title}
        onClose={() => setPreviewVersion(null)}
      />
    </Drawer>
  );
}

/* ---------------- Cross-entity links drawer ---------------- */
function LinksDrawer({
  doc, entityType, entityId, canWrite, onClose,
}: {
  doc: DocRow | null; entityType: string; entityId: string; canWrite: boolean; onClose: () => void;
}) {
  const toast = useToast();
  const { data, isLoading } = useLinks(doc?.id ?? null);
  const { add, remove } = useMutateLink(entityType, entityId, doc?.id ?? null);
  const [newType, setNewType] = useState('');
  const [newId, setNewId] = useState('');
  const links = data?.links ?? [];

  const addLink = async () => {
    if (!newType.trim() || !newId.trim()) { toast.error('Entity type and ID are both required.'); return; }
    try {
      await add.mutateAsync({ entityType: newType.trim(), entityId: newId.trim() });
      toast.success('Link added');
      setNewType(''); setNewId('');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not add the link.');
    }
  };

  const removeLink = async (l: LinkRow) => {
    try {
      await remove.mutateAsync({ entityType: l.entityType, entityId: l.entityId });
      toast.success('Link removed');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not remove the link.');
    }
  };

  return (
    <Drawer
      open={!!doc}
      onClose={onClose}
      title="Cross-entity links"
      subtitle={doc?.fileName ?? doc?.title}
      width={460}
    >
      <div className={styles.sectionBlock}>
        <p className={styles.banner}>
          <Info size={16} aria-hidden />
          One file can relate to many records without duplication. Links point to any entity (e.g. contract, party, claim) by its UUID.
        </p>

        {canWrite && (
          <div className={styles.sectionBlock}>
            <p className={styles.sectionTitle}>Add a link</p>
            <TextField label="Entity type" value={newType} onChange={setNewType} placeholder="e.g. contract, party, claim" required />
            <TextField label="Entity ID (UUID)" value={newId} onChange={setNewId} placeholder="e.g. 5f0e…" required />
            <div>
              <Button variant="secondary" icon={<Link2 size={15} />} loading={add.isPending} onClick={addLink}>Add link</Button>
            </div>
          </div>
        )}

        <div className={styles.linkList}>
          {isLoading && <p className={styles.sub}>Loading links…</p>}
          {!isLoading && links.length === 0 && <p className={styles.sub}>No links yet.</p>}
          {links.map((l) => (
            <div key={`${l.entityType}:${l.entityId}`} className={styles.linkItem}>
              <div>
                <div><Badge color="teal" variant="outline">{titleCase(l.entityType)}</Badge></div>
                <div className={styles.linkRef}>{l.entityId}</div>
              </div>
              {canWrite && (
                <Button size="sm" variant="ghost" icon={<Trash2 size={15} />} title="Remove link" loading={remove.isPending} onClick={() => removeLink(l)} />
              )}
            </div>
          ))}
        </div>
      </div>
    </Drawer>
  );
}

/* ---------------- AI extraction modal ---------------- */
function ExtractModal({ doc, canWrite, onClose }: { doc: DocRow | null; canWrite: boolean; onClose: () => void }) {
  const toast = useToast();
  const extract = useExtract();
  const [result, setResult] = useState<Extraction | null>(null);

  // Reset the result when a different document is opened.
  const [lastId, setLastId] = useState<string | null>(null);
  if (doc && doc.id !== lastId) { setLastId(doc.id); setResult(null); }

  const run = async () => {
    if (!doc) return;
    try {
      const res = await extract.mutateAsync(doc.id);
      setResult(res.extraction);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Extraction failed.');
    }
  };

  const fieldEntries = result ? Object.entries(result.fields) : [];

  return (
    <Modal
      open={!!doc}
      onClose={onClose}
      title="Extract fields (AI)"
      description={doc?.fileName ?? doc?.title}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          {canWrite && (
            <Button variant="primary" icon={<Sparkles size={15} />} loading={extract.isPending} onClick={run}>
              {result ? 'Re-run extraction' : 'Run extraction'}
            </Button>
          )}
        </>
      }
    >
      {!result && (
        <p className={styles.banner}>
          <Info size={16} aria-hidden />
          Runs the reinsurance field extractor over the document's captured text. Text formats (txt, csv, eml) carry searchable text; scanned images/PDFs are not OCR'd, so extraction will be empty for them.
        </p>
      )}

      {result && (
        <>
          <div className={result.llmUsed ? styles.banner : styles.stub}>
            <Info size={16} aria-hidden />
            {result.note}
          </div>
          {!result.llmUsed && (
            <p className={styles.sub} style={{ marginTop: 'var(--space-2)' }}>
              No values were inferred - the fields below are shown as not-extracted rather than blanks presented as data.
            </p>
          )}
          <div className={styles.extractGrid}>
            {fieldEntries.map(([field, f]) => (
              <div key={field} className={styles.extractRow}>
                <span className={styles.extractField}>{titleCase(field)}</span>
                <span className={f.value ? styles.extractValue : styles.extractValueEmpty}>
                  {f.value ?? 'not extracted'}
                </span>
                <ConfidenceBadge confidence={f.confidence} />
              </div>
            ))}
          </div>
          <div className={styles.stub} style={{ marginTop: 'var(--space-3)' }}>
            <Info size={14} aria-hidden />
            Apply-to-record is not available - there is no endpoint to write extracted fields back onto the source entity. The extraction is stored on the document for reference.
          </div>
        </>
      )}
    </Modal>
  );
}
