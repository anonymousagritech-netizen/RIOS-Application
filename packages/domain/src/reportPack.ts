/**
 * Governed report-pack assembler (brief §13, §18.3).
 *
 * A pure engine that turns a report-pack *template* (sections of line items, some
 * supplied as inputs, some computed as sums/differences of other lines) plus a
 * set of figures into a resolved pack, checking completeness and control-total
 * ties. This is the honest, jurisdiction-agnostic scaffolding beneath statutory
 * packs (Schedule F, QRTs): the *structure and validation* are delivered here;
 * the specific regulatory line taxonomy and factors are supplied as a template
 * (configuration), not hard-coded.
 */

export type LineKind = 'input' | 'sum' | 'diff';

export interface ReportLine {
  code: string;
  label: string;
  kind: LineKind;
  /** For 'input' lines: whether a figure must be supplied. */
  required?: boolean;
  /** For 'sum'/'diff' lines: the child codes. diff = first - sum(rest). */
  of?: string[];
}

export interface ReportSection {
  code: string;
  title: string;
  lines: ReportLine[];
}

export interface ControlCheck {
  /** Two resolved codes that must be equal (a cross-foot / tie-out). */
  code: string;
  equals: string;
}

export interface ReportPackTemplate {
  code: string;
  title: string;
  sections: ReportSection[];
  /** Optional grand-total line code to surface as totalMinor. */
  totalLineCode?: string;
  controls?: ControlCheck[];
}

export interface ResolvedLine {
  code: string;
  label: string;
  kind: LineKind;
  valueMinor: number | null;
}

export interface ReportPackResult {
  code: string;
  title: string;
  sections: { code: string; title: string; lines: ResolvedLine[] }[];
  /** Every resolved code -> value in minor units. */
  values: Record<string, number>;
  totalMinor: number | null;
  errors: string[];
  complete: boolean;
}

/**
 * Assemble a report pack from a template and supplied figures (minor units,
 * keyed by line code). Inputs are taken as given; sum/diff lines are resolved
 * iteratively (they may reference other computed lines). Missing required
 * inputs, unresolvable computed lines and failed control ties are reported;
 * `complete` is true only when there are no errors.
 */
export function assembleReportPack(template: ReportPackTemplate, figures: Record<string, number>): ReportPackResult {
  const errors: string[] = [];
  const values: Record<string, number> = {};
  const allLines = template.sections.flatMap((s) => s.lines);

  // 1) Seed inputs.
  for (const line of allLines) {
    if (line.kind === 'input') {
      const v = figures[line.code];
      if (v === undefined) {
        if (line.required) errors.push(`Missing required input: ${line.code} (${line.label})`);
      } else {
        values[line.code] = Math.round(v);
      }
    }
  }

  // 2) Resolve sum/diff lines iteratively until stable.
  const computed = allLines.filter((l) => l.kind === 'sum' || l.kind === 'diff');
  let progressed = true;
  const pending = new Set(computed.map((l) => l.code));
  while (progressed && pending.size > 0) {
    progressed = false;
    for (const line of computed) {
      if (!pending.has(line.code)) continue;
      const of = line.of ?? [];
      if (of.some((c) => values[c] === undefined)) continue; // not ready yet
      const nums = of.map((c) => values[c]!);
      if (line.kind === 'sum') {
        values[line.code] = nums.reduce((a, b) => a + b, 0);
      } else {
        const [head, ...rest] = nums;
        values[line.code] = (head ?? 0) - rest.reduce((a, b) => a + b, 0);
      }
      pending.delete(line.code);
      progressed = true;
    }
  }
  for (const code of pending) {
    const line = computed.find((l) => l.code === code)!;
    errors.push(`Cannot resolve ${code} (${line.label}): missing input(s) ${(line.of ?? []).filter((c) => values[c] === undefined).join(', ')}`);
  }

  // 3) Control ties.
  for (const ctrl of template.controls ?? []) {
    const a = values[ctrl.code];
    const b = values[ctrl.equals];
    if (a === undefined || b === undefined) {
      errors.push(`Control ${ctrl.code} = ${ctrl.equals}: a value is missing`);
    } else if (a !== b) {
      errors.push(`Control failed: ${ctrl.code} (${a}) != ${ctrl.equals} (${b})`);
    }
  }

  const sections = template.sections.map((s) => ({
    code: s.code,
    title: s.title,
    lines: s.lines.map((l) => ({
      code: l.code,
      label: l.label,
      kind: l.kind,
      valueMinor: values[l.code] ?? null,
    })),
  }));

  return {
    code: template.code,
    title: template.title,
    sections,
    values,
    totalMinor: template.totalLineCode ? (values[template.totalLineCode] ?? null) : null,
    errors,
    complete: errors.length === 0,
  };
}
