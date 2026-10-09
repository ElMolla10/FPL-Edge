/**
 * The BEST DECISION pipeline, shared by the browser (Overview, Transfers) and the Worker cron that
 * sends email call alerts (app/lib/call-alerts). Pure: no React, no localStorage, no D1.
 *
 * These functions used to live in app/components/coach/CoachCore.tsx. They were moved verbatim (only
 * `rankTransfersForBestDecision` gained an optional `rules` passthrough) so the server computes the
 * call with the very same code the client renders, not a parallel rule. CoachCore re-exports them, so
 * every existing import path is unchanged. Do not fork this logic: change it here and both sides move.
 */
import {FplData,FplPlayer,projectionMetrics,futureEvents,isCompleteSquad,bestXi,playerProjection,startPct} from "./fpl";
import {createOptimizer} from "./optimizer";
import {BenchOrderResult,optimizeBenchOrder,modeledAppearanceProbability} from "./bench-order";
import {Transfer,sortTransfersByQuality,bestTransfers} from "./transfers";
import type {TransferEngineRules} from "./transfer-engine";
import type {ManagerMeta} from "./squad-comparison";
import {resolveAuthoritativeFreeTransfers} from "./personal-fpl-transfer/ft-state";
import {isWildcardActive} from "./personal-fpl-transfer/chip-state";

export const clamp=(n:number,min=0,max=100)=>Math.max(min,Math.min(max,n));

export function benchOrderForEvent(xi:FplPlayer[],bench:FplPlayer[],eventId:number,data:Pick<FplData,"fixtures">):BenchOrderResult{
  return optimizeBenchOrder(xi,bench,player=>{const metrics=projectionMetrics(player,eventId,data.fixtures,eventId);return{xPts:metrics.xPts,appearanceProbability:modeledAppearanceProbability(player,metrics)}});
}

export function analysis(data:FplData,squad:FplPlayer[]){const events=futureEvents(data,5);if(!events.length||!isCompleteSquad(squad,data))return null;const first=events[0].id;const xi=bestXi(squad,first,data.fixtures,first);const rawBench=squad.filter(p=>!xi.players.some(x=>x.id===p.id));const benchOrder=benchOrderForEvent(xi.players,rawBench,first,data);const bench=benchOrder.bench;const vice=[...xi.players].sort((a,b)=>playerProjection(b,first,data.fixtures,first)-playerProjection(a,first,data.fixtures,first))[1];const issues=squad.filter(p=>p.status!=="a"||startPct(p,first,data)<68).sort((a,b)=>startPct(a,first,data)-startPct(b,first,data));const cost=squad.reduce((s,p)=>s+p.price,0);return{events,first,xi,bench,benchOrder,vice,issues,cost,bank:Math.max(0,data.rules.budget-cost)}}


// Squad-level objective delta (bench utility, flexibility, risk-adjustment, role security) for a
// swap, kept as a distinct "Model Utility Change" metric — never merged into raw projected points.
export function withModelUtilityChange(rows:Transfer[],squad:FplPlayer[],optimizer:ReturnType<typeof createOptimizer>|null):Transfer[]{
  if(!optimizer||!squad.length)return rows;
  const baseline=optimizer.evaluate(squad).objective;
  const adjustedRows=rows.map(r=>{
    const index=squad.findIndex(p=>p.id===r.out.id);
    if(index<0)return r;
    const swapped=[...squad];swapped[index]=r.incoming;
    const utilityChange=optimizer.evaluate(swapped).objective-baseline;
    const adjusted=r.rankScore+clamp(utilityChange,-10,10)*.2;
    const rankScore=r.qualityStatus==="blocked"?Math.min(0,adjusted):r.qualityStatus==="watchlist"?Math.min(2.19,adjusted):adjusted;
    return{...r,utilityChange,rankScore};
  });
  return sortTransfersByQuality(adjustedRows);
}

/** Shared Transfers ranking pipeline before selectBestDecision: deep limit 60 + model utility.
 *  Overview deferred deep must call this (not hang-safe restricted budgets alone) so BEST DECISION matches.
 *  `options.rules` is optional and unused by the browser. The email cron passes a larger plan time budget so
 *  the (otherwise wall-clock-truncated) search is bounded only by the deterministic node cap, which keeps the
 *  hourly call stable under Worker load. */
export function rankTransfersForBestDecision(
  data:FplData,
  squad:FplPlayer[],
  bank:number,
  freeTransfers:number,
  sellingPrices:Map<number,number>,
  optimizer:ReturnType<typeof createOptimizer>|null,
  options?:{wildcardActive?:boolean;rules?:Partial<TransferEngineRules>},
):Transfer[]{
  const base=bestTransfers(data,squad,bank,freeTransfers,60,sellingPrices,{
    mode:"deep",
    wildcardActive:options?.wildcardActive===true,
    rules:options?.rules,
  });
  return withModelUtilityChange(base,squad,optimizer);
}

/** Free transfers the ranking uses: live my-team allotment when known, else `fallback` (the browser passes the
 *  Transfers selector from localStorage; the server cron has no such setting and passes the same default, 1). */
export function resolveFreeTransfersFromMeta(meta:ManagerMeta|null|undefined,fallback:number):number{
  return resolveAuthoritativeFreeTransfers({
    freeTransferLimit:meta?.freeTransferLimit,
    transfersMade:meta?.transfersMade,
    bankSource:meta?.bankSource,
    fallbackFreeTransfers:fallback,
  });
}

export function managerWildcardActive(meta:ManagerMeta|null|undefined):boolean{
  return isWildcardActive({
    activeChip:meta?.chip,
    freeTransferLimit:meta?.freeTransferLimit,
    bankSource:meta?.bankSource,
  });
}
