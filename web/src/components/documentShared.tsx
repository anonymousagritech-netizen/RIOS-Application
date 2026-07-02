/**
 * Shared document-engine helpers used by both DocumentsPanel (embedded on
 * entity detail pages) and DocumentsPage (global search workspace).
 *
 * Everything here maps 1:1 to the real Document Engine API
 * (server/src/modules/documents.ts): the MIME allowlist, the doc_status
 * approval ladder, base64 file <-> browser helpers, and a single
 * mime-aware in-browser preview modal (GET /api/documents/:id/content).
 *
 * The React Query hook here is local to this shared component file (not added
 * to lib/queries.ts) so the preview surface can be reused without duplication.
 */
import { useQuery } from '@tanstack/react-query';
import { Modal } from './Modal';
import { Button } from './Button';
import { Badge } from './Badge';
import { Download, FileWarning } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { formatDate } from '../lib/format';
import { useToast } from './Toast';
import styles from './documentShared.module.css';

/* ---------------- Enterprise document categories ----------------
 * Defined as a const for now. These can move to a metadata code list
 * (e.g. POST /api/config/code-lists/document.category/values) later without
 * touching this file's callers. */
export const DOC_CATEGORIES = [
  'Slip',
  'MRC Slip',
  'Cover Note',
  'Treaty Wording',
  'Schedule',
  'Endorsement',
  'Financial Statements',
  'Exposure File',
  'CAT Model Report',
  'Bordereaux',
  'Claims Bordereaux',
  'Loss Runs',
  'Inspection Report',
  'Survey Report',
  'Pricing Sheet',
  'Emails',
  'Broker Correspondence',
  'Sanctions/KYC',
  'Legal Documents',
  'Regulatory Documents',
  'Other',
] as const;

/* ---------------- doc_status approval ladder (mirrors the server) ----------------
 * DRAFT -> UPLOADED -> REVIEWED -> APPROVED -> LOCKED -> ARCHIVED
 * APPROVED may step back to REVIEWED. ARCHIVED is terminal. */
export const DOC_STATUS_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['UPLOADED'],
  UPLOADED: ['REVIEWED'],
  REVIEWED: ['APPROVED'],
  APPROVED: ['LOCKED', 'REVIEWED'],
  LOCKED: ['ARCHIVED'],
  ARCHIVED: [],
};

export function nextDocStatuses(status: string | null | undefined): string[] {
  if (!status) return [];
  return DOC_STATUS_TRANSITIONS[status.toUpperCase()] ?? [];
}

/* ---------------- MIME allowlist (mirrors the server allowlist) ---------------- */
const EXT_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  txt: 'text/plain',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  zip: 'application/zip',
  eml: 'message/rfc822',
};

/** File-picker accept string covering the allowlisted formats. */
export const ACCEPT_EXTENSIONS = '.pdf,.docx,.xlsx,.csv,.txt,.jpg,.jpeg,.png,.tif,.tiff,.zip,.eml';

/** Human label for the allowlist, shown in the dropzone hint. */
export const ALLOWED_LABEL = 'PDF, DOCX, XLSX, CSV, TXT, JPG, PNG, TIFF, ZIP, EML - up to 10 MB each';

/**
 * Infer an allowlisted MIME type from the file name extension, falling back to
 * the browser-reported type. Browsers frequently report docx/xlsx/eml with an
 * empty or generic type, so the extension is authoritative when we know it.
 */
export function inferMimeType(fileName: string, browserType?: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase();
  if (ext && EXT_MIME[ext]) return EXT_MIME[ext];
  return browserType || 'application/octet-stream';
}

/** How a given MIME type can be previewed in-browser. */
export type PreviewMode = 'image' | 'pdf' | 'text' | 'none';

export function previewMode(mimeType: string | null | undefined): PreviewMode {
  if (!mimeType) return 'none';
  if (mimeType === 'image/jpeg' || mimeType === 'image/png') return 'image';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType === 'text/plain' || mimeType === 'text/csv' || mimeType === 'message/rfc822') return 'text';
  // docx, xlsx, zip, tiff are not browser-native: honest "download to view".
  return 'none';
}

/* ---------------- base64 <-> browser helpers ---------------- */

/** Read a picked/dropped File to a bare base64 string (no data: prefix). */
export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = reader.result as string;
      const comma = res.indexOf(',');
      resolve(comma >= 0 ? res.slice(comma + 1) : res);
    };
    reader.onerror = () => reject(reader.error ?? new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function decodeText(b64: string): string {
  try {
    return new TextDecoder().decode(base64ToBytes(b64));
  } catch {
    return atob(b64);
  }
}

/** Trigger a browser download of a base64 payload with the correct MIME type. */
export function downloadBase64(fileName: string, mimeType: string, contentBase64: string): void {
  const bytes = base64ToBytes(contentBase64);
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: mimeType || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName || 'document';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ---------------- Content query (local to this shared file) ---------------- */
export interface DocContent {
  fileName: string;
  mimeType: string;
  contentBase64: string;
}

function useDocumentContent(id: string | null, version?: number | null) {
  return useQuery({
    queryKey: ['document-content', id, version ?? 'head'],
    queryFn: () =>
      api<DocContent>(`/api/documents/${id}/content${version ? `?version=${version}` : ''}`),
    enabled: !!id,
  });
}

/* ---------------- Preview body (mime-aware) ---------------- */
function PreviewBody({ content }: { content: DocContent }) {
  const mode = previewMode(content.mimeType);
  if (mode === 'image') {
    return (
      <img
        className={styles.previewImage}
        src={`data:${content.mimeType};base64,${content.contentBase64}`}
        alt={content.fileName}
      />
    );
  }
  if (mode === 'pdf') {
    return (
      <iframe
        className={styles.previewFrame}
        title={content.fileName}
        src={`data:application/pdf;base64,${content.contentBase64}`}
      />
    );
  }
  if (mode === 'text') {
    return <pre className={styles.previewText}>{decodeText(content.contentBase64)}</pre>;
  }
  return (
    <div className={styles.notice}>
      <FileWarning size={16} aria-hidden />
      <div>
        <p className={styles.noticeTitle}>Preview not available in-browser</p>
        <p className={styles.noticeMsg}>
          {content.mimeType} cannot be rendered natively by the browser. Download the file to view it.
        </p>
      </div>
    </div>
  );
}

/* ---------------- Shared preview modal ----------------
 * Fetches GET /api/documents/:id/content (optionally ?version=) and renders by
 * MIME: images inline, PDF in an iframe, text/csv/eml as <pre>, and an honest
 * "download to view" notice for docx/xlsx/zip/tiff. */
export function DocumentPreviewModal({
  docId,
  version,
  label,
  onClose,
}: {
  docId: string | null;
  version?: number | null;
  label?: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const { data, isLoading, isError, error } = useDocumentContent(docId, version);

  const title = label ?? data?.fileName ?? 'Document';
  const description =
    data
      ? `${data.mimeType}${version ? ` · version ${version}` : ''}`
      : version
        ? `version ${version}`
        : undefined;

  const download = () => {
    if (!data) return;
    try {
      downloadBase64(data.fileName, data.mimeType, data.contentBase64);
    } catch {
      toast.error('Could not prepare the download.');
    }
  };

  return (
    <Modal
      open={!!docId}
      onClose={onClose}
      title={title}
      description={description}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          {data && (
            <Button variant="secondary" icon={<Download size={15} />} onClick={download}>
              Download
            </Button>
          )}
        </>
      }
    >
      {isLoading && <p className={styles.muted}>Loading document…</p>}
      {isError && (
        <p className={styles.error} role="alert">
          {error instanceof ApiError ? error.message : 'Could not load the document.'}
        </p>
      )}
      {data && <PreviewBody content={data} />}
    </Modal>
  );
}

/* ---------------- Confidence badge (AI extraction) ---------------- */
export function ConfidenceBadge({ confidence }: { confidence: number }) {
  const pct = Math.round((confidence ?? 0) * 100);
  const color = confidence >= 0.75 ? 'green' : confidence >= 0.4 ? 'amber' : 'gray';
  return <Badge color={color} variant="soft">{pct}% confidence</Badge>;
}

/** Format an ISO date for a compact "who/when" line. */
export function whenLabel(iso: string | null | undefined): string {
  return formatDate(iso);
}
