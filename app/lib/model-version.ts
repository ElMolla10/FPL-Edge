import { PROJECTION_MODEL_VERSION } from "./fpl";

export type ModelRelease={
  version:string;
  short:string;
  title:string;
  released:string;
  current:boolean;
  changes:string[];
};

export const MODEL_RELEASES:ModelRelease[]=[
  {
    version:"fpl-edge-2026.08.23-r6",short:"r6",title:"Multi-gameweek transfer routes",released:"23 Aug 2026",current:true,
    changes:["Searches roll, single-transfer and double-transfer decisions across 3–8 gameweeks.","Carries exact selling values, bank, free transfers and hit costs through every deadline.","Freezes the four best complete routes inside version-7 deadline receipts."],
  },
  {
    version:"fpl-edge-2026.08.23-r5",short:"r5",title:"Autosub-aware bench ordering",released:"23 Aug 2026",current:false,
    changes:["Evaluates all six outfield bench permutations.","Weights player appearance uncertainty across legal autosub scenarios.","Freezes the recommended bench order in deadline receipts."],
  },
  {
    version:"fpl-edge-2026.08.23-r4",short:"r4",title:"Team quality & opponent context",released:"23 Aug 2026",current:false,
    changes:["Adds normalized home/away team attack and defence strength.","Prices promoted-club uncertainty conservatively.","Uses both the player's team and the opponent in fixture projections."],
  },
  {
    version:"fpl-edge-2026.08.23-r3",short:"r3",title:"Transfer quality gate",released:"23 Aug 2026",current:false,
    changes:["Separates actionable, watchlist and blocked routes.","Makes evidence, minutes security and multi-week robustness affect rank."],
  },
  {
    version:"fpl-edge-2026.08.22-r2",short:"r2",title:"Premier League evidence calibration",released:"22 Aug 2026",current:false,
    changes:["Introduces explicit Premier League evidence groups.","Applies stronger shrinkage and confidence caps to limited or missing PL history."],
  },
];

export const modelRelease=(version:string|null|undefined)=>MODEL_RELEASES.find(release=>release.version===version)??null;
export const modelDisplayName=(version:string|null|undefined)=>{
  if(!version)return"Legacy / unversioned";
  const release=modelRelease(version);
  return release?`${release.short} · ${release.title}`:version;
};
export const modelVersionKey=(version:string|null|undefined)=>version||"legacy";

export function groupByModelVersion<T>(rows:T[],versionOf:(row:T)=>string|null|undefined){
  const groups=new Map<string,T[]>();
  for(const row of rows){const key=modelVersionKey(versionOf(row));groups.set(key,[...(groups.get(key)??[]),row])}
  return groups;
}

export function comparableModelRows<T>(rows:T[],version:string,versionOf:(row:T)=>string|null|undefined){
  return rows.filter(row=>modelVersionKey(versionOf(row))===version);
}

export const currentModelRelease=()=>modelRelease(PROJECTION_MODEL_VERSION);
