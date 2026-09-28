/**
 * Accuracy slices built on History receipt evaluations.
 * Extends one-GW MAE with minutes-risk bands and multi-horizon MAE from frozen paths.
 * Self-contained (no CoachApp import) so tests and API routes stay free of UI cycles.
 */
import { minutesRiskBand, MINUTES_RISK_ORDER, type MinutesRiskBand } from "./minutes-risk";

export type AccuracyMetric = {
  rows: number;
  activeRows: number;
  pointsMae: number | null;
  pointsBias: number | null;
  withinTwoPct: number | null;
  minutesMae: number | null;
  startBrier: number | null;
};

/** Minimal row shape shared with CoachApp ProjectionPlayerEvaluationRow. */
export type AccuracyPlayerRow = {
  event: number;
  playerId: number;
  positionShort: string | null;
  projectedPoints: number;
  actualPoints: number;
  error: number;
  signedError: number;
  expectedMinutes: number;
  actualMinutes: number;
  startProbability: number;
  started: boolean;
  confidenceBand: string;
};

export type HorizonDepth = 1 | 3 | 5;

export type HorizonAccuracyRow = {
  event: number;
  playerId: number;
  positionShort: string | null;
  minutesRisk: MinutesRiskBand;
  horizon: HorizonDepth;
  projectedPoints: number;
  actualPoints: number;
  error: number;
  signedError: number;
};

export type AccuracySlice = {
  key: string;
  label: string;
  metric: AccuracyMetric;
};

export type AccuracyReport = {
  modelVersion: string | null;
  evaluatedGameweeks: number;
  overall: AccuracyMetric;
  byPosition: AccuracySlice[];
  byMinutesRisk: AccuracySlice[];
  byHorizon: AccuracySlice[];
  byConfidence: AccuracySlice[];
};

type ReceiptPlayerTuple = [
  number, number, string, string | null, number, number, number, number, number, number, number,
  number[], number?, string?, string | null?, boolean | null?,
];

const receiptNumber = (value: number, places = 2) => Number(value.toFixed(places));
const average = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);

/** Same active-row rule as CoachApp.aggregateAccuracy. */
export function aggregateAccuracyRows(rows: AccuracyPlayerRow[]): AccuracyMetric {
  const active = rows.filter((row) => row.projectedPoints >= 0.5 || row.actualMinutes > 0);
  return {
    rows: rows.length,
    activeRows: active.length,
    pointsMae: active.length ? receiptNumber(average(active.map((row) => row.error))) : null,
    pointsBias: active.length ? receiptNumber(average(active.map((row) => row.signedError))) : null,
    withinTwoPct: active.length ? receiptNumber((active.filter((row) => row.error <= 2).length / active.length) * 100, 1) : null,
    minutesMae: rows.length ? receiptNumber(average(rows.map((row) => Math.abs(row.actualMinutes - row.expectedMinutes))), 1) : null,
    startBrier: rows.length ? receiptNumber(average(rows.map((row) => Math.pow((row.started ? 1 : 0) - row.startProbability, 2))), 3) : null,
  };
}

export function sliceByPosition(rows: AccuracyPlayerRow[]): AccuracySlice[] {
  const map = new Map<string, AccuracyPlayerRow[]>();
  for (const row of rows) {
    const key = row.positionShort ?? "LEGACY";
    map.set(key, [...(map.get(key) ?? []), row]);
  }
  const order = ["GKP", "DEF", "MID", "FWD", "LEGACY"];
  return [...map]
    .map(([key, values]) => ({
      key,
      label: key === "LEGACY" ? "Legacy / unknown" : key,
      metric: aggregateAccuracyRows(values),
    }))
    .sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
}

export function sliceByMinutesRisk(rows: AccuracyPlayerRow[]): AccuracySlice[] {
  const map = new Map<MinutesRiskBand, AccuracyPlayerRow[]>();
  for (const row of rows) {
    const band = minutesRiskBand(row.startProbability);
    map.set(band, [...(map.get(band) ?? []), row]);
  }
  return MINUTES_RISK_ORDER.filter((band) => map.has(band)).map((band) => ({
    key: band,
    label:
      band === "Secure"
        ? "Secure minutes (≥80% start)"
        : band === "Moderate"
          ? "Moderate minutes (50–79%)"
          : "Risky minutes (<50%)",
    metric: aggregateAccuracyRows(map.get(band)!),
  }));
}

export function sliceByConfidence(rows: AccuracyPlayerRow[]): AccuracySlice[] {
  const map = new Map<string, AccuracyPlayerRow[]>();
  for (const row of rows) {
    map.set(row.confidenceBand, [...(map.get(row.confidenceBand) ?? []), row]);
  }
  const order = ["High", "Medium", "Low"];
  return [...map]
    .map(([key, values]) => ({ key, label: key, metric: aggregateAccuracyRows(values) }))
    .sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
}

/**
 * Multi-horizon MAE from frozen receipt paths vs completed official points.
 * actualByEventPlayer keys: `${eventId}:${playerId}` → actual points.
 */
export function horizonAccuracyRows(input: {
  event: number;
  receiptPlayers: ReceiptPlayerTuple[];
  actualByEventPlayer: Map<string, number>;
  completedEventIds: number[];
}): HorizonAccuracyRow[] {
  const { event, receiptPlayers, actualByEventPlayer, completedEventIds } = input;
  if (!receiptPlayers.length || !completedEventIds.length) return [];
  const depths: HorizonDepth[] = [1, 3, 5];
  const rows: HorizonAccuracyRow[] = [];
  for (const player of receiptPlayers) {
    const playerId = player[0];
    const path = player[11] ?? [];
    const positionShort = (player[13] as string | undefined) ?? null;
    const startProbability = player[6] ?? 0;
    const risk = minutesRiskBand(startProbability);
    for (const horizon of depths) {
      if (completedEventIds.length < horizon) continue;
      const eventIds = completedEventIds.slice(0, horizon);
      let projected = 0;
      let actual = 0;
      let missing = false;
      for (let i = 0; i < horizon; i++) {
        const p = path[i];
        const a = actualByEventPlayer.get(`${eventIds[i]}:${playerId}`);
        if (typeof p !== "number" || a === undefined) {
          missing = true;
          break;
        }
        projected += p;
        actual += a;
      }
      if (missing) continue;
      rows.push({
        event,
        playerId,
        positionShort,
        minutesRisk: risk,
        horizon,
        projectedPoints: projected,
        actualPoints: actual,
        error: Math.abs(actual - projected),
        signedError: actual - projected,
      });
    }
  }
  return rows;
}

export function sliceByHorizon(rows: HorizonAccuracyRow[]): AccuracySlice[] {
  const depths: HorizonDepth[] = [1, 3, 5];
  return depths
    .map((horizon) => {
      const subset = rows.filter((row) => row.horizon === horizon);
      const synthetic: AccuracyPlayerRow[] = subset.map((row) => ({
        event: row.event,
        playerId: row.playerId,
        positionShort: row.positionShort,
        projectedPoints: row.projectedPoints,
        actualPoints: row.actualPoints,
        error: row.error,
        signedError: row.signedError,
        expectedMinutes: 90,
        actualMinutes: 90,
        startProbability: 1,
        started: true,
        confidenceBand: "High",
      }));
      return {
        key: String(horizon),
        label: horizon === 1 ? "1 GW ahead" : `${horizon} GW sum`,
        metric: aggregateAccuracyRows(synthetic),
      };
    })
    .filter((slice) => slice.metric.rows > 0);
}

export function buildAccuracyReport(
  modelVersion: string | null,
  playerRows: AccuracyPlayerRow[],
  evaluatedGameweeks: number,
  horizonRows: HorizonAccuracyRow[] = [],
): AccuracyReport {
  return {
    modelVersion,
    evaluatedGameweeks,
    overall: aggregateAccuracyRows(playerRows),
    byPosition: sliceByPosition(playerRows),
    byMinutesRisk: sliceByMinutesRisk(playerRows),
    byHorizon: sliceByHorizon(horizonRows),
    byConfidence: sliceByConfidence(playerRows),
  };
}

/** Public JSON shape for /api/fpl/accuracy (no PII). */
export function publishAccuracyPayload(report: AccuracyReport | null, generatedAt: string) {
  return {
    generatedAt,
    source: "fpl-edge-receipt-evaluations",
    note: "Metrics are derived from frozen pre-deadline projection receipts graded against official finished events. Samples below five evaluated gameweeks are early evidence.",
    report: report
      ? {
          modelVersion: report.modelVersion,
          evaluatedGameweeks: report.evaluatedGameweeks,
          overall: report.overall,
          byPosition: report.byPosition,
          byMinutesRisk: report.byMinutesRisk,
          byHorizon: report.byHorizon,
          byConfidence: report.byConfidence,
        }
      : null,
  };
}
