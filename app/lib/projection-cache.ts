/**
 * Projection cache keyed by player / GW / modelVersion / dataTimestamp.
 * In-request Maps stay fine for planners; this helper standardises keys so
 * callers never mix generations or stale bootstrap payloads.
 */
import { PROJECTION_MODEL_VERSION } from "./fpl";
import type { ProjectionMetrics } from "./fpl";

export type ProjectionCacheKey = {
  playerId: number;
  eventId: number;
  modelVersion?: string;
  dataTimestamp?: string;
};

export function projectionCacheKey({
  playerId,
  eventId,
  modelVersion = PROJECTION_MODEL_VERSION,
  dataTimestamp = "",
}: ProjectionCacheKey): string {
  return `${modelVersion}|${dataTimestamp}|${playerId}|${eventId}`;
}

export class ProjectionMetricsCache {
  private readonly store = new Map<string, ProjectionMetrics>();
  constructor(
    private readonly modelVersion = PROJECTION_MODEL_VERSION,
    private readonly dataTimestamp = "",
  ) {}

  get(playerId: number, eventId: number): ProjectionMetrics | undefined {
    return this.store.get(
      projectionCacheKey({
        playerId,
        eventId,
        modelVersion: this.modelVersion,
        dataTimestamp: this.dataTimestamp,
      }),
    );
  }

  set(playerId: number, eventId: number, metrics: ProjectionMetrics): void {
    this.store.set(
      projectionCacheKey({
        playerId,
        eventId,
        modelVersion: this.modelVersion,
        dataTimestamp: this.dataTimestamp,
      }),
      metrics,
    );
  }

  get size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }
}
