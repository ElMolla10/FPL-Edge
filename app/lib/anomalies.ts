import { FplPlayer, ProjectionMetrics } from "./fpl";

export type AnomalyFlag = { code: string; message: string };

const PRICE_BUDGET_MID = 5.5;
const PRICE_TYPICAL_DEF = 6.0;

export function playerAnomalies(player: FplPlayer, gw1: ProjectionMetrics): AnomalyFlag[] {
  const flags: AnomalyFlag[] = [];
  if (player.positionShort === "MID" && player.price <= PRICE_BUDGET_MID && gw1.xPts > 7) {
    flags.push({
      code: "budget-mid-overprojection",
      message: `£${player.price.toFixed(1)}m midfielder projects ${gw1.xPts.toFixed(1)} xPts in GW1 — verify this isn't driven by a small sample (${player.priorMinutes} prior minutes, ${player.priorStarts} prior starts).`,
    });
  }
  if (player.positionShort === "DEF" && player.price < PRICE_TYPICAL_DEF && gw1.xPts > 6) {
    flags.push({
      code: "defender-overprojection",
      message: `Defender projects ${gw1.xPts.toFixed(1)} xPts in an ordinary fixture — verify clean-sheet, DC and bonus components are not double-counted.`,
    });
  }
  if (gw1.startProbability < 0.5 && gw1.xPts > 6) {
    flags.push({
      code: "low-certainty-elite-projection",
      message: `Only ${Math.round(gw1.startProbability * 100)}% start probability but ${gw1.xPts.toFixed(1)} xPts projected — high-variance projection, treat with caution.`,
    });
  }
  if (player.priorMinutes < 180 && gw1.xPts > 4) {
    flags.push({
      code: "tiny-sample-projection",
      message: `Only ${player.priorMinutes} prior-season minutes on record but projects ${gw1.xPts.toFixed(1)} xPts — verify the underlying rates are shrunk toward a sane baseline, not extrapolated from a tiny sample.`,
    });
  }
  return flags;
}

export type FiveGwGainBand = "negligible" | "modest" | "strong" | "exceptional" | "anomaly";

export function classifyFiveGwGain(gain5: number): FiveGwGainBand {
  const magnitude = Math.abs(gain5);
  if (magnitude > 15) return "anomaly";
  if (magnitude >= 10) return "exceptional";
  if (magnitude >= 5) return "strong";
  if (magnitude >= 2) return "modest";
  return "negligible";
}

export function transferAnomalies(
  out: FplPlayer,
  incoming: FplPlayer,
  gain5: number,
  outGw1: ProjectionMetrics,
  inGw1: ProjectionMetrics,
  refreshChangePct?: number,
): AnomalyFlag[] {
  const flags: AnomalyFlag[] = [...playerAnomalies(incoming, inGw1)];
  const band = classifyFiveGwGain(gain5);
  if (band === "anomaly") {
    flags.push({
      code: "five-gw-gain-anomaly",
      message: `${Math.abs(gain5).toFixed(1)} pts projected over five gameweeks exceeds the +15 anomaly threshold for a same-price-bracket swap — projection requires review before acting on it.`,
    });
  }
  if (inGw1.startProbability < 0.6 && gain5 > 5) {
    flags.push({
      code: "high-risk-top-recommendation",
      message: `The incoming player carries only ${Math.round(inGw1.startProbability * 100)}% start probability. The projected gain leans on volume/rate upside, not certainty — the risk should be weighed explicitly, not assumed away.`,
    });
  }
  if (refreshChangePct !== undefined && Math.abs(refreshChangePct) > 0.3 && incoming.status === "a" && !incoming.news) {
    flags.push({
      code: "unexplained-refresh-swing",
      message: `Projection changed ${(refreshChangePct * 100).toFixed(0)}% since the last data refresh with no accompanying news/status change.`,
    });
  }
  return flags;
}
