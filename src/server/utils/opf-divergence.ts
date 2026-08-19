import type { OpfDiagnostic, OpfMetadata, OpfParseOutcome } from './opf-reader.js';

/**
 * `OpfMetadata` declaration order. `changed_fields` and `previous` are both keyed on it so a
 * divergence card lists fields the same way twice, and so the payload cannot drift when the
 * reader gains a field: adding one to `OpfMetadata` without adding it here fails to typecheck.
 */
const OPF_FIELD_ORDER: Record<keyof OpfMetadata, true> = {
  title: true, subtitle: true, authors: true, narrators: true, description: true,
  publisher: true, publishedDate: true, asin: true, isbn: true, seriesName: true,
  seriesPosition: true, genres: true,
};

export type OpfField = keyof OpfMetadata;

// String keys enumerate in insertion order, so the literal above IS the order.
const OPF_FIELDS = Object.keys(OPF_FIELD_ORDER) as OpfField[];

/** What the writer is about to destroy, in the shape the event and the renderer both consume. */
export interface SidecarDivergence {
  changedFields: OpfField[];
  /** The *existing* side's recovered values, never the generated ones. */
  previous: Partial<OpfMetadata>;
  /** Nothing compared unequal; only the reader's caps stopped equivalence from being provable. */
  equivalenceUnproven: boolean;
  previousUnavailable: boolean;
  generatedUnparseable: boolean;
}

export type DivergenceVerdict =
  | { diverged: false }
  | { diverged: true; divergence: SidecarDivergence };

function isRecovered(value: OpfMetadata[OpfField]): boolean {
  return Array.isArray(value) ? value.length > 0 : value !== null;
}

function recoveredFields(metadata: OpfMetadata): OpfField[] {
  return OPF_FIELDS.filter((field) => isRecovered(metadata[field]));
}

/**
 * Arrays compare element-wise **in order**: `generateOpf` emits authors and narrators in the DB's
 * order and primary-author position is meaningful, so a reorder is a real divergence.
 */
function fieldEquals(a: OpfMetadata, b: OpfMetadata, field: OpfField): boolean {
  const left = a[field];
  const right = b[field];
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
  return left === right;
}

function pick(metadata: OpfMetadata, fields: OpfField[]): Partial<OpfMetadata> {
  const picked: Record<string, unknown> = {};
  // A key present with a null value is what distinguishes "previously had no position" from
  // "unchanged, so not listed at all" — never drop the key.
  for (const field of fields) picked[field] = metadata[field];
  return picked as Partial<OpfMetadata>;
}

function diagnosticFields(diagnostics: OpfDiagnostic[]): OpfField[] {
  const flagged = new Set(diagnostics.map((diagnostic) => diagnostic.field));
  return OPF_FIELDS.filter((field) => flagged.has(field));
}

/**
 * Decide whether replacing the existing sidecar destroys anything.
 *
 * Two gates, both failing toward preservation. If **either** side failed to parse, equivalence
 * cannot be proven and the file is preserved — the short-circuit "nothing parsed, so there is
 * nothing to compare" destroys precisely the corrupt-but-still-readable file an operator would
 * most want back. If both parsed and every field matched, the reader's caps can still have
 * flattened two genuinely different files onto one bounded value, so any truncation/cap/drop
 * diagnostic on either side also preserves. Failing this way costs one backup; failing the other
 * way destroys the tail of an over-long field.
 */
export function detectSidecarDivergence(existing: OpfParseOutcome, generated: OpfParseOutcome): DivergenceVerdict {
  const existingMeta = existing.metadata;
  const generatedMeta = generated.metadata;

  if (existingMeta === null || generatedMeta === null) {
    const changedFields = existingMeta !== null
      ? recoveredFields(existingMeta)
      : generatedMeta !== null ? recoveredFields(generatedMeta) : [];
    return {
      diverged: true,
      divergence: {
        changedFields,
        previous: existingMeta !== null ? pick(existingMeta, changedFields) : {},
        equivalenceUnproven: false,
        previousUnavailable: existingMeta === null,
        generatedUnparseable: generatedMeta === null,
      },
    };
  }

  const changedFields = OPF_FIELDS.filter((field) => !fieldEquals(existingMeta, generatedMeta, field));
  if (changedFields.length > 0) {
    return {
      diverged: true,
      divergence: {
        changedFields,
        previous: pick(existingMeta, changedFields),
        equivalenceUnproven: false,
        previousUnavailable: false,
        generatedUnparseable: false,
      },
    };
  }

  const unproven = diagnosticFields([...existing.diagnostics, ...generated.diagnostics]);
  if (unproven.length === 0) return { diverged: false };
  return {
    diverged: true,
    divergence: {
      changedFields: unproven,
      previous: pick(existingMeta, unproven),
      equivalenceUnproven: true,
      previousUnavailable: false,
      generatedUnparseable: false,
    },
  };
}

/**
 * The event's `reason`. `previous` is a bounded triage summary, not the recovery source — its
 * values have passed the reader's caps, so an over-long field appears truncated or absent here
 * while `metadata.opf.bak` holds it whole. No backup path is stored: the name is a constant and
 * the folder is always the book's *current* folder, so a stored path would go stale on the first
 * rename with nothing to update it.
 */
export function buildDivergenceReason(divergence: SidecarDivergence): Record<string, unknown> {
  return {
    changed_fields: divergence.changedFields,
    previous: divergence.previous,
    ...(divergence.equivalenceUnproven && { equivalence_unproven: true }),
    ...(divergence.previousUnavailable && { previous_unavailable: true }),
    ...(divergence.generatedUnparseable && { generated_unparseable: true }),
  };
}
