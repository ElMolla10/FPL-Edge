/** Default My team gameweek: the live GW (current && !finished), else the upcoming planning GW
 *  (the header countdown's GW). A finished GW is never the first paint; it stays reachable via prev. */
export function defaultTeamEventId(current:{id:number;finished:boolean}|null,upcoming:{id:number}[],fallback:number):number{
  if(current&&!current.finished)return current.id;
  return upcoming[0]?.id??current?.id??fallback;
}
