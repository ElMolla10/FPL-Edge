/** Minutes-risk bands for accuracy slices (frozen from startProbability at receipt time). */
export type MinutesRiskBand = "Secure" | "Moderate" | "Risky";

/** Secure ≥80% start · Moderate ≥50% · Risky below that. */
export function minutesRiskBand(startProbability: number): MinutesRiskBand {
  if (startProbability >= 0.8) return "Secure";
  if (startProbability >= 0.5) return "Moderate";
  return "Risky";
}

export const MINUTES_RISK_ORDER: MinutesRiskBand[] = ["Secure", "Moderate", "Risky"];
