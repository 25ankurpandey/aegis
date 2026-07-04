import type {
  DangerAssessment,
  DangerFacts,
  DangerLevel,
  VerbClass,
} from './types';

/**
 * @aegis/ai-core / danger — the DETERMINISTIC danger classifier (docs/strategy §3.1).
 *
 * `classifyDanger` scores each dimension as a PURE FUNCTION of DangerFacts, then combines with
 * `level = min(cap, max(dim1..dim5))` followed by an anomaly bump. Rationale (§3.1):
 *   - MAX, not sum: one maxed dimension is enough (a $2M single-row payment is critical even though
 *     it is one reversible row); summing would let many small scores manufacture false alarms.
 *   - Anomaly is ADVISORY: it can only RAISE the level by at most `anomalyBumpCap` (default 1) and
 *     NEVER lowers it, and it is NEVER the sole basis for a hard response (the policy layer requires a
 *     deterministic dimension ≥ 3 for second_approver / block — see danger-policy.ts).
 *   - Deterministic-first: the ledger can record "rule blast_radius.delete ≥ 2500 matched count=4211,
 *     ruleset defaults" — explainable to a regulator; and there is no prompt-injection surface,
 *     because the classifier never reads model output.
 */

/** Tunable thresholds. All optional; sane platform-floor defaults are documented per field. */
export interface DangerClassifierOptions {
  /** Row-count breakpoints for the blast-radius dimension (ascending). Default: [2, 26, 251, 2501]. */
  blastRadiusThresholds?: [number, number, number, number];
  /** Monetary breakpoints in MINOR units (cents), ascending. Default: $500/$5k/$25k/$100k. */
  monetaryThresholdsMinor?: [number, number, number, number];
  /** PII-export row breakpoints (ascending). Default: [1, 101, 10001] ⇒ 1/3/4. */
  piiExportThresholds?: [number, number, number];
  /** Max the anomaly signal may raise the level. Default 1; clamped to [0, 2]. */
  anomalyBumpCap?: number;
  /** Anomaly score at/above which the bump fires. Default 0.8 (normalized 0..1). */
  anomalyBumpAt?: number;
  /** Hard ceiling for the returned level. Default 5. */
  maxLevel?: DangerLevel;
}

interface ResolvedOptions {
  blastRadiusThresholds: [number, number, number, number];
  monetaryThresholdsMinor: [number, number, number, number];
  piiExportThresholds: [number, number, number];
  anomalyBumpCap: number;
  anomalyBumpAt: number;
  maxLevel: DangerLevel;
}

const DEFAULTS: ResolvedOptions = {
  blastRadiusThresholds: [2, 26, 251, 2501],
  monetaryThresholdsMinor: [50_000, 500_000, 2_500_000, 10_000_000],
  piiExportThresholds: [1, 101, 10_001],
  anomalyBumpCap: 1,
  anomalyBumpAt: 0.8,
  maxLevel: 5,
};

function resolve(opts?: DangerClassifierOptions): ResolvedOptions {
  return {
    blastRadiusThresholds: opts?.blastRadiusThresholds ?? DEFAULTS.blastRadiusThresholds,
    monetaryThresholdsMinor: opts?.monetaryThresholdsMinor ?? DEFAULTS.monetaryThresholdsMinor,
    piiExportThresholds: opts?.piiExportThresholds ?? DEFAULTS.piiExportThresholds,
    anomalyBumpCap: clamp(opts?.anomalyBumpCap ?? DEFAULTS.anomalyBumpCap, 0, 2),
    anomalyBumpAt: opts?.anomalyBumpAt ?? DEFAULTS.anomalyBumpAt,
    maxLevel: opts?.maxLevel ?? DEFAULTS.maxLevel,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** How many thresholds a value has crossed: 0 below the first, N once past the Nth. */
function bucket(value: number, thresholds: readonly number[]): number {
  let score = 0;
  for (const t of thresholds) {
    if (value >= t) score += 1;
  }
  return score;
}

/**
 * Dim 1 — destructiveness / irreversibility. Pure function of verbClass × irreversible.
 *   read=0 · create=1 · update=1 · execute=2 · delete=2 (delete+irreversible=3) · irreversible bumps +1.
 */
function scoreDestructiveness(verb: VerbClass, irreversible: boolean, reasons: string[]): number {
  const base: Record<VerbClass, number> = {
    read: 0,
    create: 1,
    update: 1,
    execute: 2,
    delete: 2,
  };
  let s = base[verb];
  if (irreversible && verb !== 'read') {
    s += 1;
    reasons.push(`destructiveness: ${verb} is irreversible (+1)`);
  } else if (s >= 2) {
    reasons.push(`destructiveness: ${verb} (${s})`);
  }
  return Math.min(4, s);
}

export function classifyDanger(
  facts: DangerFacts,
  opts?: DangerClassifierOptions,
): DangerAssessment {
  const o = resolve(opts);
  const reasons: string[] = [];

  const irreversible = facts.irreversible === true;
  const count = facts.count ?? 1;
  const sensitivity = facts.dataSensitivity ?? 'none';

  // Dim 1 — destructiveness / irreversibility.
  const destructiveness = scoreDestructiveness(facts.verbClass, irreversible, reasons);

  // Dim 2 — blast radius from the pre-flight count. read/create do not accrue destructive blast, but
  // a bulk read that is ALSO a PII export is caught by the sensitivity dimension below.
  let blastRadius = 0;
  if (facts.verbClass !== 'read') {
    blastRadius = bucket(count, o.blastRadiusThresholds);
    if (blastRadius > 0) reasons.push(`blastRadius: count=${count} (${blastRadius})`);
  }

  // Dim 3 — monetary value.
  let monetary = 0;
  if (typeof facts.amountMinor === 'number' && facts.amountMinor > 0) {
    monetary = bucket(facts.amountMinor, o.monetaryThresholdsMinor);
    if (monetary > 0) reasons.push(`monetary: amountMinor=${facts.amountMinor} (${monetary})`);
  }

  // Dim 4 — data sensitivity. PII/financial export scales with row count; secret ⇒ min 3.
  let sensitivityScore = 0;
  const isExport = facts.verbClass === 'read';
  if (sensitivity === 'secret') {
    sensitivityScore = Math.max(sensitivityScore, 3);
    reasons.push('sensitivity: secret data (min 3)');
  }
  if (sensitivity === 'pii' || sensitivity === 'financial') {
    const rows = isExport ? count : Math.max(1, count);
    const b = bucket(rows, o.piiExportThresholds); // 1 / 3 / 4 style via three thresholds
    // Map bucket 1→1, 2→3, 3→4 to match the graduated PII-export scale.
    const mapped = b === 0 ? 0 : b === 1 ? 1 : b === 2 ? 3 : 4;
    if (mapped > 0) {
      sensitivityScore = Math.max(sensitivityScore, mapped);
      reasons.push(`sensitivity: ${sensitivity} rows=${rows} (${mapped})`);
    }
  }

  // Dim 5 — regulatory impact (static registry touch). Any touch ⇒ 3; irreversible touch ⇒ 4.
  let regulatory = 0;
  if (facts.regulatory === true) {
    regulatory = irreversible ? 4 : 3;
    reasons.push(`regulatory: touch (${regulatory})`);
  }

  const deterministicDims = [
    destructiveness,
    blastRadius,
    monetary,
    sensitivityScore,
    regulatory,
  ];
  const deterministicMax = Math.max(...deterministicDims);

  // Dim 6 — anomaly. ADVISORY: raises by at most anomalyBumpCap; never lowers; never the sole gate
  // (the policy layer gates hard responses on a deterministic dim ≥ 3, so a miscalibrated anomaly
  // model cannot lock out legitimate work).
  let anomalyBump = 0;
  const anomalyScore = facts.anomaly?.score ?? 0;
  if (anomalyScore >= o.anomalyBumpAt) {
    anomalyBump = o.anomalyBumpCap;
    reasons.push(
      `anomaly: score=${anomalyScore}${facts.anomaly?.reason ? ` (${facts.anomaly.reason})` : ''} bump +${anomalyBump}`,
    );
  }

  const level = clamp(deterministicMax + anomalyBump, 0, o.maxLevel) as DangerLevel;

  return {
    level,
    dimensions: {
      destructiveness,
      blastRadius,
      monetary,
      sensitivity: sensitivityScore,
      regulatory,
      anomaly: anomalyBump,
    },
    reasons,
  };
}
