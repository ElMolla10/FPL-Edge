import type { FplPlayer } from "./fpl";

// Lives here (not in CoachApp.tsx, where it was originally written) so LiveDraftBuilder.tsx's
// "apply Triple Captain" action can import it directly -- CoachApp.tsx already imports
// LiveDraftBuilder, so LiveDraftBuilder importing this back from CoachApp.tsx would be a circular
// import. Same reason Pitch.tsx and transfer-quality.ts were extracted before it.
export type CaptaincyResolution={captainId:number;viceId:number};
// Pure so the exact same resolution useCaptaincy() uses (Team, Final Check) can also be called
// directly by Overview -- guarantees all three screens agree on captain/vice, rather than Overview
// maintaining its own separate, incomplete copy of this priority chain (the bug this fixes: Overview
// previously skipped the manager-captainId tier entirely).
export function resolveCaptaincy(players:FplPlayer[],storedCaptainId:number,storedViceId:number,managerCaptainId:number|null|undefined,managerViceCaptainId:number|null|undefined,modelCaptain:FplPlayer|undefined,modelVice:FplPlayer|undefined):CaptaincyResolution|null{
  if(!players.length)return null;
  const valid=(id:number|null|undefined)=>!!id&&players.some(p=>p.id===id);
  const captainId=valid(storedCaptainId)?storedCaptainId:valid(managerCaptainId)?managerCaptainId!:modelCaptain?.id??players[0].id;
  let viceId=valid(storedViceId)?storedViceId:valid(managerViceCaptainId)?managerViceCaptainId!:modelVice?.id??players.find(p=>p.id!==captainId)?.id??captainId;
  if(viceId===captainId)viceId=players.find(p=>p.id!==captainId)?.id??captainId;
  return{captainId,viceId};
}

// Extracted so Draft Lab's "apply Triple Captain" action (LiveDraftBuilder.tsx) can reuse the
// exact same vice-preserving rule instead of reimplementing it: the chosen player becomes captain;
// vice is preserved UNLESS the chosen player already was vice, in which case the old captain
// becomes the new vice (a swap). Both currentCaptainId/currentViceId are expected already fully
// resolved (e.g. via resolveCaptaincy) -- this function contains no fallback chains of its own.
export function resolveCaptainSwap(currentCaptainId:number,currentViceId:number,chosenId:number):{captainId:number;viceId:number}{
  return{captainId:chosenId,viceId:chosenId===currentViceId?currentCaptainId:currentViceId};
}
