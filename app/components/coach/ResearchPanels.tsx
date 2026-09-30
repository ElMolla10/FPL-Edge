"use client";

import {useState,useMemo,useEffect} from "react";
import {LineupCandidate,clubLineupCandidates,LINEUP_POSITIONS} from "../../lib/lineup-intelligence";
import {FplData,futureEvents,FplPlayer,FplEvent,savedSquad,PlayerCalibrationGroup,PROJECTION_MODEL_VERSION,projectionMetrics,playerCalibrationProfile} from "../../lib/fpl";
import {useTeamLinkAuth} from "../team-link-auth";
import {modelRelease,MODEL_RELEASES,groupByModelVersion,comparableModelRows,modelDisplayName} from "../../lib/model-version";
import {templateByPosition,rawDifferentialsByPosition} from "../../lib/ownership-radar";
import {computeClubFixtureRows,ClubFixtureRow,difficultyScoreOutOf10} from "../../lib/fixture-difficulty";
import {qualityPopulation,qualityScoreOutOf10} from "../../lib/team-quality";
import {horizonAccuracyRows,buildAccuracyReport,type AccuracyPlayerRow} from "../../lib/model-accuracy";
import {minutesRiskBand} from "../../lib/minutes-risk";
import {ConnectTeam,EmptyDeskState,PhoneSquadNav,clamp} from "./CoachCore";
import type {View} from "./CoachCore";
import {average,receiptNumber} from "./PanelShared";
import type {HistoryPlayerStats,HistoryWeek,LockRecord} from "./PanelShared";
import {ChipPortfolioPanel,LiveChips,LiveHistory} from "../LiveIntelligence";

export function TeamQualityPanel({data}:{data:FplData}){
  const[dimension,setDimension]=useState<"attack"|"defence">("attack");
  const rows=data.teams.filter(team=>team.quality).map(team=>{const quality=team.quality!;const home=dimension==="attack"?quality.effectiveAttackHome:quality.effectiveDefenceHome,away=dimension==="attack"?quality.effectiveAttackAway:quality.effectiveDefenceAway;return{team,quality,home,away,overall:(home+away)/2}}).sort((a,b)=>b.overall-a.overall);
  if(!rows.length)return null;
  const homePopulation=qualityPopulation(data.teams,dimension,"home"),awayPopulation=qualityPopulation(data.teams,dimension,"away");
  return <section className="team-quality-panel"><header><div><span>TEAM QUALITY MODEL</span><h2>Attack and defence are separate signals.</h2><p>League-normalized official priors update gradually from completed Premier League results. A single clean sheet or haul cannot rewrite a club's rating. Scores are 0-10, 10 = best, relative to the 20 clubs modeled this season -- the top and bottom club will always read close to 10 and 0 even in a tightly-matched league.</p></div><div className="segmented"><button className={dimension==="attack"?"active":""} onClick={()=>setDimension("attack")}>Attack</button><button className={dimension==="defence"?"active":""} onClick={()=>setDimension("defence")}>Defence</button></div></header><div className="team-quality-grid">{rows.map((row,index)=><article key={row.team.id}><i>{index+1}</i><b>{row.team.short}<small>{row.team.name}</small></b><p><span>HOME</span><strong>{qualityScoreOutOf10(row.home,homePopulation).toFixed(1)}/10</strong></p><p><span>AWAY</span><strong>{qualityScoreOutOf10(row.away,awayPopulation).toFixed(1)}/10</strong></p><p><span>CONFIDENCE</span><strong>{Math.round(row.quality.confidence*100)}%</strong></p><em className={row.quality.lowPlContinuity?"provisional":"established"}>{row.quality.lowPlContinuity?"LOW-CONTINUITY PRIOR":`${row.quality.matches} PL MATCH${row.quality.matches===1?"":"ES"}`}</em></article>)}</div><footer>Scores are relative to the 20 clubs modeled this season, not a fixed baseline. Ratings use genuine Premier League evidence only; promoted and low-continuity squads start conservatively and gain authority as completed top-flight matches accumulate.</footer></section>;
}

// Feature #9 v1: global template ownership + raw differentials, both off already-fetched data
// (selectedBy is real and first-party; xPts5 reuses the same playerProjection every other page
// already uses). Deliberately does NOT attempt effective ownership (captaincy-adjusted) -- FPL
// blocks per-manager picks (and even its own single-winner most_captained field) for any
// gameweek until AFTER that gameweek's deadline has passed, confirmed live against the real API,
// so a live captaincy-adjusted number is a genuine timing wall, not a cost tradeoff, the same
// category as Feature #5's declined formation-shape claim. A retrospective (already-locked-
// gameweek) version is real and buildable but logged as its own separate, smaller, deferred item
// -- not folded in here.
export function OwnershipRadar({data}:{data:FplData}){
  const events=futureEvents(data,5);
  const eventIds=events.map(e=>e.id);
  const template=useMemo(()=>templateByPosition(data.players,data.rules.positions),[data]);
  const differentials=useMemo(()=>rawDifferentialsByPosition(data.players,data.rules.positions,data.fixtures,eventIds),[data,eventIds.join(",")]);
  return <div className="coach-page">
    <section className="research-intro"><div><span>OWNERSHIP RADAR</span><h2>Who the population owns, and who they're missing.</h2><p>Ownership shown is raw selection % from the live FPL feed, not effective ownership — FPL doesn't publish real per-player captaincy rates for a gameweek until after its own deadline has passed, so a live captaincy-adjusted number can't be sourced honestly here. Prices and availability are live.</p></div></section>
    <section className="ownership-radar-group"><header><span>TEMPLATE OWNERSHIP</span><h3>The most-owned players, by position.</h3><p>A live ownership snapshot, not a squad recommendation — budget and the 3-per-club limit aren't checked here, so these players aren't guaranteed to fit together into one legal squad.</p></header>
      <div className="ownership-position-grid">{template.map(group=><article key={group.position.id}><h4>{group.position.name}</h4>{group.players.map(p=><p key={p.id}><b>{p.name}</b><small>{p.teamShort}</small><span>{p.selectedBy.toFixed(1)}%</span></p>)}{!group.players.length&&<small className="ownership-empty">No players fetched for this position.</small>}</article>)}</div>
    </section>
    <section className="ownership-radar-group"><header><span>RAW DIFFERENTIALS</span><h3>Low-owned starters with real projected upside, by position.</h3><p>Only players the model treats as likely starters (same minutes/start floor as route security). Ranked by projected points and ownership together — not a fixed ownership cutoff — so a moderately-owned starter with a strong projection can rank above a barely-owned starter with a weak one. Bench and third-choice players are excluded.</p></header>
      <div className="ownership-position-grid">{differentials.map(group=><article key={group.position.id}><h4>{group.position.name}</h4>{group.players.map(({player,xPts5})=><p key={player.id}><b>{player.name}</b><small>{player.teamShort}</small><span>{player.selectedBy.toFixed(1)}% owned</span><strong>{xPts5.toFixed(1)} xPts</strong></p>)}{!group.players.length&&<small className="ownership-empty">No likely starters clear the bar for this position.</small>}</article>)}</div>
    </section>
  </div>;
}

type SeasonStatSort=keyof Pick<FplPlayer,"totalPoints"|"pointsPerGame"|"goals"|"assists"|"expectedGoals"|"expectedAssists"|"expectedGoalInvolvements"|"cleanSheets"|"bonus"|"defensiveContribution"|"minutes"|"form">;

// "form" is FPL's own official field (bootstrap-static's raw player.form, already fetched and
// mapped in app/api/fpl/route.ts) -- average points per match over roughly the player's last 30
// days, a genuinely different window from every other column here (season-to-date totals through
// data.seasonStatsThrough). Sorted last and labeled explicitly as a recent-window stat so it never
// reads as just another cumulative number.
const SEASON_STAT_SORTS:[SeasonStatSort,string][]=[["totalPoints","Total points"],["pointsPerGame","Points per match"],["goals","Goals"],["assists","Assists"],["expectedGoals","xG"],["expectedAssists","xA"],["expectedGoalInvolvements","xGI"],["cleanSheets","Clean sheets"],["bonus","Bonus"],["defensiveContribution","Defensive contribution"],["minutes","Minutes"],["form","Form (last 30 days)"]];

type TeamStatSort="goalsFor"|"goalsAgainst"|"goalDifference"|"expectedGoalsFor"|"expectedGoalsAgainst"|"cleanSheets"|"matches";

const TEAM_STAT_SORTS:[TeamStatSort,string][]=[["goalsFor","Goals for"],["goalsAgainst","Goals against"],["goalDifference","Goal difference"],["expectedGoalsFor","xG for"],["expectedGoalsAgainst","xG against"],["cleanSheets","Clean sheets"],["matches","Matches played"]];

// Pure past-performance leaderboards -- unlike the Players research page (which defaults to and
// mixes in 3/5-GW xPts), nothing here is a projection: every column is a real season-to-date total
// already on FplPlayer (players) or newly exposed on FplData's teams array (clubs -- see
// app/api/fpl/route.ts, previously computed there only as team-quality's own input and dropped
// before the response left the server). Default sort is Total points, the least ambiguous
// "already happened" number in FPL's own vocabulary.
export function SeasonStats({data}:{data:FplData}){
  const[query,setQuery]=useState("");const[pos,setPos]=useState("ALL");const[club,setClub]=useState("ALL");const[sort,setSort]=useState<SeasonStatSort>("totalPoints");const[direction,setDirection]=useState<"desc"|"asc">("desc");const[more,setMore]=useState(false);const[showFilters,setShowFilters]=useState(false);
  const[teamSort,setTeamSort]=useState<TeamStatSort>("goalsFor");const[teamDirection,setTeamDirection]=useState<"desc"|"asc">("desc");
  const rows=useMemo(()=>data.players.filter(p=>(pos==="ALL"||p.positionShort===pos)&&(club==="ALL"||String(p.teamId)===club)&&(`${p.name} ${p.teamName}`).toLowerCase().includes(query.toLowerCase())).sort((a,b)=>{const value=(p:FplPlayer)=>Number(p[sort])||0;return direction==="desc"?value(b)-value(a):value(a)-value(b)}),[data,pos,club,query,sort,direction]);
  const teamRows=useMemo(()=>data.teams.map(team=>{const goalsFor=(team.goalsForHome??0)+(team.goalsForAway??0);const goalsAgainst=(team.goalsAgainstHome??0)+(team.goalsAgainstAway??0);return{team,matches:team.matches??0,goalsFor,goalsAgainst,goalDifference:goalsFor-goalsAgainst,expectedGoalsFor:team.expectedGoalsFor??0,expectedGoalsAgainst:team.expectedGoalsAgainst??0,cleanSheets:team.cleanSheets??0}}).sort((a,b)=>{const value=(r:typeof a)=>r[teamSort];return teamDirection==="desc"?value(b)-value(a):value(a)-value(b)}),[data,teamSort,teamDirection]);
  return <div className="coach-page season-stats">
    <section className="research-intro player-count"><div><span>SEASON 2026/27 · PAST PERFORMANCE</span><h2>Season Stats</h2><p>{data.seasonStatsThrough?`Pure season-to-date totals through GW${data.seasonStatsThrough} — real results only, no projections or xPts.`:`No 2026/27 gameweek has finished yet, so season totals correctly start at zero.`}</p></div><strong>{rows.length}<small>players shown</small></strong></section>
    <button type="button" className="filter-toggle" aria-expanded={showFilters} onClick={()=>setShowFilters(v=>!v)}>{showFilters?"Hide filters":"Show filters"}</button>
    <section className={showFilters?"research-filters is-open":"research-filters"} hidden={!showFilters}>
      <input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search player or club…"/>
      <select value={pos} onChange={e=>setPos(e.target.value)}><option value="ALL">All positions</option>{data.rules.positions.map(p=><option key={p.id}>{p.short}</option>)}</select>
      <select value={club} onChange={e=>setClub(e.target.value)}><option value="ALL">All clubs</option>{data.teams.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select>
      <select value={sort} onChange={e=>setSort(e.target.value as SeasonStatSort)}>{SEASON_STAT_SORTS.map(([value,label])=><option value={value} key={value}>Sort: {label}</option>)}</select>
      <button onClick={()=>setDirection(x=>x==="desc"?"asc":"desc")}>{direction==="desc"?"High → low":"Low → high"}</button>
      <button type="button" onClick={()=>setMore(x=>!x)}>{more?"Fewer columns":"More columns"}</button>
    </section>
    <section className={more?"season-table player-grid wide sticky-head":"season-table player-grid sticky-head"}>
      <header>{(more?["Player","Points","Per match","Goals","Assists","xG","xA","xGI","Clean sheets","Bonus","Def. contribution","Minutes","Form (last 30 days)"]:["Player","Points","Goals","Assists","Minutes"]).map(x=><span key={x}>{x}</span>)}</header>
      {rows.slice(0,150).map(p=><article key={p.id}><b>{p.name}<small>{p.teamShort} · {p.positionShort}</small></b><strong>{p.totalPoints}</strong>{more&&<span>{p.pointsPerGame.toFixed(1)}</span>}<span>{p.goals}</span><span>{p.assists}</span>{more&&<><span>{p.expectedGoals.toFixed(2)}</span><span>{p.expectedAssists.toFixed(2)}</span><span>{p.expectedGoalInvolvements.toFixed(2)}</span><span>{p.cleanSheets}</span><span>{p.bonus}</span><span>{p.defensiveContribution}</span></>}<span>{p.minutes}</span>{more&&<em className="season-stat-recent">{p.form.toFixed(1)}</em>}</article>)}
    </section>
    <section className="season-stats-section-intro"><span>CLUBS · SEASON TOTALS</span><h2>Team season stats</h2><p>Real goals, expected goals and clean sheets from completed fixtures this season — separate from the Team Quality model's 0-10 relative rating shown on the Fixtures and Points model pages.</p></section>
    <div className="season-stats-sort-row"><select value={teamSort} onChange={e=>setTeamSort(e.target.value as TeamStatSort)}>{TEAM_STAT_SORTS.map(([value,label])=><option value={value} key={value}>Sort: {label}</option>)}</select><button onClick={()=>setTeamDirection(x=>x==="desc"?"asc":"desc")}>{teamDirection==="desc"?"High → low":"Low → high"}</button></div>
    <section className="season-table team-grid sticky-head">
      <header><span>Club</span><span>Matches</span><span>Goals for</span><span>Goals against</span><span>Goal diff</span><span>xG for</span><span>xG against</span><span>Clean sheets</span></header>
      {teamRows.map(r=><article key={r.team.id}><b>{r.team.name}<small>{r.team.short}</small></b><span>{r.matches}</span><span>{r.goalsFor}</span><span>{r.goalsAgainst}</span><strong>{r.goalDifference>=0?"+":""}{r.goalDifference}</strong><span>{r.expectedGoalsFor.toFixed(1)}</span><span>{r.expectedGoalsAgainst.toFixed(1)}</span><span>{r.cleanSheets}</span></article>)}
    </section>
  </div>;
}

export function TeamQualityFixtures({data}:{data:FplData}){
  const[horizon,setHorizon]=useState(8);
  const[sort,setSort]=useState<"attack"|"defence">("attack");
  const events=futureEvents(data,horizon);
  const rows=[...computeClubFixtureRows(data,horizon)].sort((a,b)=>sort==="attack"?a.attack-b.attack:a.defence-b.defence);
  const attack=[...rows].sort((a,b)=>a.attack-b.attack).slice(0,3),defence=[...rows].sort((a,b)=>a.defence-b.defence).slice(0,3),avoid=[...rows].sort((a,b)=>b.attack-a.attack).slice(0,3),swings=[...rows].sort((a,b)=>b.swing-a.swing).slice(0,3);
  return <div className="team-quality-fixtures"><section className="fixture-summary"><div><span>QUALITY-AWARE FIXTURE TICKER</span><h2>Opponent difficulty and each club's own quality now move together.</h2><p>Higher scores are better (0-10, 10 = best). Attack rankings compare a club's attack with the opponent's defence; clean-sheet rankings compare its defence with the opponent's attack.</p></div><div>{[3,5,8].map(value=><button className={horizon===value?"active":""} onClick={()=>setHorizon(value)} key={value}>{value} GW</button>)}</div></section><div className="schedule-ranks"><Rank title="Best attacking schedules" rows={attack} keyName="attack"/><Rank title="Best defensive schedules" rows={defence} keyName="defence"/><Rank title="Fixture swings" rows={swings} keyName="swing"/><Rank title="Teams to avoid" rows={avoid} keyName="attack" bad/></div><section className="fixture-ticker"><header><div><span>TEAM</span><button className={sort==="attack"?"active":""} onClick={()=>setSort("attack")}>ATTACK</button><button className={sort==="defence"?"active":""} onClick={()=>setSort("defence")}>DEFENCE</button></div>{events.map(event=><span key={event.id}>{event.name.replace("Gameweek ","GW")}</span>)}</header>{rows.map(row=><FixtureTickerRow row={row} events={events} sort={sort} key={row.team.id}/>)}</section></div>;
}

function FixtureTickerRow({row,events,sort}:{row:ClubFixtureRow;events:FplEvent[];sort:"attack"|"defence"}){
  return <article><div><b>{row.team.short}<small>{row.team.name}</small></b><span>{difficultyScoreOutOf10(row.attack).toFixed(1)}/10 ATK</span><span>{difficultyScoreOutOf10(row.defence).toFixed(1)}/10 DEF</span></div>{row.cells.map((cell,index)=>{const value=sort==="attack"?cell.attack:cell.defence,multiplier=sort==="attack"?cell.attackMultiplier:cell.defenceMultiplier;return <span className={`fdr-${Math.round(value)}`} key={events[index].id}><b>{cell.label}</b><small>{cell.label==="BLANK"?"—":`${difficultyScoreOutOf10(value).toFixed(1)}/10 · ×${multiplier.toFixed(2)}`}</small></span>})}</article>;
}

function PublicGameweekFixtures({data}:{data:FplData}){
  const event=futureEvents(data,1)[0]??data.events.find(e=>e.current);
  if(!event)return <p className="empty-why">No gameweek is published yet.</p>;
  const short=(id:number)=>data.teams.find(team=>team.id===id)?.short??"—";
  const fixtures=data.fixtures.filter(fixture=>fixture.event===event.id).sort((a,b)=>Date.parse(a.kickoff??"")-Date.parse(b.kickoff??""));
  return <div className="coach-page"><section className="fixture-summary"><div><h2 className="gw-one-line">{event.name}</h2><p>No team is connected.</p></div></section><section className="public-fixtures">{fixtures.map(fixture=><article key={fixture.id}><b>{short(fixture.teamH)} v {short(fixture.teamA)}</b><time>{fixture.kickoff?new Date(fixture.kickoff).toLocaleString([],{weekday:"short",day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}):"Time TBC"}</time></article>)}</section></div>;
}

export function MyFixtures({data,go,revision,onTeamChange}:{data:FplData;go:(v:View)=>void;revision:number;onTeamChange:()=>void}){
  const teamAuth=useTeamLinkAuth();
  const squad=useMemo(()=>savedSquad(data),[data,revision]);
  const[horizon,setHorizon]=useState(8);
  const[sort,setSort]=useState<"attack"|"defence">("attack");
  const events=futureEvents(data,horizon);
  if(!squad.length&&teamAuth!=="in")return <div className="coach-page"><PhoneSquadNav active="squad-fixtures" go={go}/><PublicGameweekFixtures data={data}/></div>;if(!squad.length)return <div className="coach-page"><PhoneSquadNav active="squad-fixtures" go={go}/><ConnectTeam data={data} onConnected={()=>onTeamChange()}/><section className="empty-command"><span>MANUAL OPTION</span><h2>Already know your draft?</h2><p>Build and save it manually first -- this view shows real fixture difficulty for the clubs your own squad's players belong to.</p><button onClick={()=>go("draft")}>Build a squad →</button></section></div>;
  const ownedTeamIds=new Set(squad.map(p=>p.teamId));
  const rows=[...computeClubFixtureRows(data,horizon)].filter(row=>ownedTeamIds.has(row.team.id)).sort((a,b)=>sort==="attack"?a.attack-b.attack:a.defence-b.defence);
  return <div className="coach-page"><PhoneSquadNav active="squad-fixtures" go={go}/><div className="team-quality-fixtures"><section className="fixture-summary"><div><span>MY SQUAD'S FIXTURES</span><h2>Real fixture difficulty for the clubs you actually own players at.</h2><p>The same club-level difficulty model as the full Fixtures page, narrowed to your own squad -- every player at a club shares that club's real fixture list, so this is per club, not per player.</p></div><div>{[3,5,8].map(value=><button className={horizon===value?"active":""} onClick={()=>setHorizon(value)} key={value}>{value} GW</button>)}</div></section><section className="fixture-ticker"><header><div><span>TEAM</span><button className={sort==="attack"?"active":""} onClick={()=>setSort("attack")}>ATTACK</button><button className={sort==="defence"?"active":""} onClick={()=>setSort("defence")}>DEFENCE</button></div>{events.map(event=><span key={event.id}>{event.name.replace("Gameweek ","GW")}</span>)}</header>{rows.map(row=><FixtureTickerRow row={row} events={events} sort={sort} key={row.team.id}/>)}</section></div></div>;
}

function Rank({title,rows,keyName,bad}:{title:string;rows:any[];keyName:string;bad?:boolean}){return <article className={bad?"avoid":""}><span>{title.toUpperCase()}</span>{rows.map((r,i)=><p key={r.team.id}><i>{i+1}</i><b>{r.team.name}</b><strong>{keyName==="swing"?`BUY LATER +${r.swing.toFixed(1)}`:`${difficultyScoreOutOf10(Number(r[keyName])).toFixed(1)}/10`}</strong></p>)}</article>}

const lineupStatusTag=(p:FplPlayer)=>p.status==="s"?"SUSPENSION":p.status==="i"||p.status==="d"?"INJURY":"FLAGGED";

const lineupCompetitionLine=(candidate:LineupCandidate)=>{
  if(!candidate.closestCompetitorName)return"No listed competition at this club in this position.";
  const points=Math.round(Math.abs(candidate.competitionGap)*100);
  if(candidate.competitionGap>0)return`Leads ${candidate.closestCompetitorName} by ${points} points.`;
  if(candidate.competitionGap<0)return`Trails ${candidate.closestCompetitorName} by ${points} points.`;
  return`Tied with ${candidate.closestCompetitorName}.`;
};

// Fixtures is already this app's per-club research page (TeamQualityFixtures above is itself a
// 20-team grid) -- lineup intelligence is another per-club concern and belongs here rather than a
// new top-level nav item, which the mobile nav would just bury under "More" anyway.
export function LineupIntelligencePanel({data}:{data:FplData}){
  const[expandedTeamId,setExpandedTeamId]=useState<number|null>(null);
  const planningEvent=futureEvents(data,1)[0]?.id;
  if(!planningEvent)return null;
  return <section className="lineup-intelligence">
    <header><span>LINEUP INTELLIGENCE</span><h2>Most likely XI, ranked by real modeled start probability.</h2><p>Ranked by this app's own modeled start probability, not an official or confirmed lineup. Clubs don't confirm their starting XI until close to kickoff.</p></header>
    <div className="lineup-clubs">{data.teams.map(team=>{
      const open=expandedTeamId===team.id;
      const candidates=open?clubLineupCandidates(data.players,team.id,planningEvent,data.fixtures,planningEvent):null;
      return <article key={team.id} className={`lineup-club${open?" open":""}`}>
        <button className="lineup-club-head" onClick={()=>setExpandedTeamId(open?null:team.id)}><b>{team.short}</b><span>{team.name}</span><i>{open?"−":"+"}</i></button>
        {open&&candidates&&<div className="lineup-club-body">
          <p className="lineup-position-note">Grouped by FPL's own goalkeeper/defender/midfielder/forward categories -- this is not a stated tactical formation.</p>
          {LINEUP_POSITIONS.map(position=><div className="lineup-position-group" key={position}>
            <span>{position}</span>
            {candidates[position].length?candidates[position].map(candidate=><article key={candidate.player.id} className="lineup-candidate">
              <div><b>{candidate.player.name}</b><small>{Math.round(candidate.startProbability*100)}% start · {Math.round(candidate.expectedMinutes)} mins</small></div>
              <div className="lineup-candidate-tags">{candidate.penaltyRole&&<em>PENALTIES</em>}{candidate.setPieceRole&&<em>SET PIECES</em>}{candidate.player.status!=="a"&&<em className="flag">{lineupStatusTag(candidate.player)}</em>}</div>
              <p className="lineup-candidate-competition">{lineupCompetitionLine(candidate)}</p>
              {candidate.player.status!=="a"&&<p className="lineup-candidate-news">{candidate.player.news||"Official FPL flag has no published detail."}</p>}
            </article>):<p className="lineup-position-empty">No listed players.</p>}
          </div>)}
        </div>}
      </article>;
    })}</div>
    <p className="lineup-disclosure-footer">Official FPL status only. No invented quotes, predicted lineups or unsupported rumours.</p>
  </section>;
}

export type ProjectionTransferEvaluation={
  rank:number;outId:number;outName:string;incomingId:number;incomingName:string;completedEvents:number;horizonEvents:number;
  projectedPlayerSwing:number|null;actualPlayerSwing:number|null;actualNetAfterHit:number|null;
  projectedFive:number;hitCost:number;reviewRequired:boolean;
};

export type ProjectionConfidenceBand="High"|"Medium"|"Low";

export type ProjectionPlayerEvaluationRow={
  event:number;playerId:number;teamId:number|null;positionShort:string|null;
  projectedPoints:number;actualPoints:number;error:number;signedError:number;
  expectedMinutes:number;actualMinutes:number;startProbability:number;started:boolean;
  confidence:number;confidenceBand:ProjectionConfidenceBand;calibrationGroup:PlayerCalibrationGroup|null;lowPlContinuityClub:boolean|null;
};

export type ProjectionEvaluation={
  event:number;modelVersion:string|null;status:"pending"|"unavailable"|"legacy"|"evaluated";completedEvents:number;horizonEvents:number;
  managerActual:number|null;actualBeforeHits:number|null;transferCost:number;officialPlanMatch:boolean|null;projectedTotal:number;
  chip:string|null;adjustedProjectedTotal:number;signedSquadError:number|null;absoluteSquadError:number|null;
  captain:{receiptCaptainId:number;officialCaptainId:number|null;effectiveCaptainId:number|null;matched:boolean|null;projectedRaw:number;actualRaw:number|null;officialContribution:number|null}|null;
  population:{rows:number;activeRows:number;allPlayerPointsMae:number;activePlayerPointsMae:number;pointsBias:number;withinTwoPct:number;minutesMae:number;startBrier:number}|null;
  playerRows:ProjectionPlayerEvaluationRow[];
  transfers:ProjectionTransferEvaluation[];
};

export const projectionConfidenceBand=(confidence:number):ProjectionConfidenceBand=>confidence>=.75?"High":confidence>=.5?"Medium":"Low";

const sameIdSet=(a:number[],b:number[])=>a.length===b.length&&[...a].sort((x,y)=>x-y).every((value,index)=>value===[...b].sort((x,y)=>x-y)[index]);

const historyPlayerStats=(week:HistoryWeek|undefined,id:number):HistoryPlayerStats|null=>{
  const stats=week?.playerStats?.[String(id)];
  if(stats)return stats;
  const points=week?.playerPoints?.[String(id)];
  return points===undefined?null:{points,minutes:0,starts:0,goals:0,assists:0,cleanSheets:0,bonus:0};
};

// Turns a frozen pre-deadline receipt into a deterministic post-gameweek audit. Official results
// stay authoritative and derived evaluations are intentionally not persisted: every refresh can
// reproduce them from the immutable receipt plus FPL's finished-event data. A squad-total error is
// only reported when the official submitted squad/XI/captaincy matches the receipt; otherwise the
// UI labels the divergence instead of grading the model against a different plan.
export function evaluateProjectionReceipt(lock:LockRecord,weeks:HistoryWeek[]):ProjectionEvaluation{
  const receipt=lock.receipt,firstWeek=weeks.find(week=>week.event===lock.event);
  if(!receipt){const managerActual=firstWeek&&!firstWeek.unavailable?Number(firstWeek.points):null,transferCost=firstWeek?.transferCost??0,scoringTotal=firstWeek?.squad?.reduce((sum,pick)=>sum+(historyPlayerStats(firstWeek,pick.elementId)?.points??0)*pick.multiplier,0)??managerActual;return{event:lock.event,modelVersion:null,status:"legacy",completedEvents:firstWeek&&!firstWeek.unavailable?1:0,horizonEvents:1,managerActual,actualBeforeHits:scoringTotal,transferCost,officialPlanMatch:null,projectedTotal:lock.predicted,chip:firstWeek?.chip??null,adjustedProjectedTotal:lock.predicted,signedSquadError:null,absoluteSquadError:null,captain:null,population:null,playerRows:[],transfers:[]}}
  if(firstWeek?.unavailable)return{event:receipt.event,modelVersion:receipt.modelVersion,status:"unavailable",completedEvents:0,horizonEvents:receipt.eventIds.length,managerActual:null,actualBeforeHits:null,transferCost:0,officialPlanMatch:null,projectedTotal:receipt.squad.predictedTotal,chip:null,adjustedProjectedTotal:receipt.squad.predictedTotal,signedSquadError:null,absoluteSquadError:null,captain:null,population:null,playerRows:[],transfers:[]};
  if(!firstWeek)return{event:receipt.event,modelVersion:receipt.modelVersion,status:"pending",completedEvents:0,horizonEvents:receipt.eventIds.length,managerActual:null,actualBeforeHits:null,transferCost:0,officialPlanMatch:null,projectedTotal:receipt.squad.predictedTotal,chip:null,adjustedProjectedTotal:receipt.squad.predictedTotal,signedSquadError:null,absoluteSquadError:null,captain:null,population:null,playerRows:[],transfers:[]};

  const weekByEvent=new Map(weeks.filter(week=>!week.unavailable).map(week=>[week.event,week]));
  let completedEvents=0;
  for(const eventId of receipt.eventIds){if(!weekByEvent.get(eventId)?.playerStats)break;completedEvents++}
  const officialSquad=firstWeek.squad?.map(pick=>pick.elementId)??[];
  const officialXi=firstWeek.squad?.filter(pick=>pick.position<=11).map(pick=>pick.elementId)??[];
  const officialBench=firstWeek.squad?.filter(pick=>pick.position>11).sort((a,b)=>a.position-b.position).map(pick=>pick.elementId)??[];
  const officialCaptainId=firstWeek.captainId??firstWeek.squad?.find(pick=>pick.isCaptain)?.elementId??null;
  const officialViceId=firstWeek.viceCaptainId??firstWeek.squad?.find(pick=>pick.isViceCaptain)?.elementId??null;
  const effectiveCaptainId=firstWeek.squad?.find(pick=>pick.multiplier>1)?.elementId??officialCaptainId;
  const receiptBench=receipt.squad.benchIds;
  const benchOrderMatch=!receiptBench||receiptBench.length===officialBench.length&&receiptBench.every((id,index)=>id===officialBench[index]);
  const officialPlanMatch=officialSquad.length===receipt.squad.squadIds.length&&sameIdSet(officialSquad,receipt.squad.squadIds)&&sameIdSet(officialXi,receipt.squad.xiIds)&&benchOrderMatch&&officialCaptainId===receipt.squad.captainId&&officialViceId===receipt.squad.viceId;
  const tupleById=new Map(receipt.players.map(player=>[player[0],player]));
  const currentProjection=(id:number)=>tupleById.get(id)?.[4]??0;
  const chip=firstWeek.chip??null;
  const benchIds=receipt.squad.squadIds.filter(id=>!receipt.squad.xiIds.includes(id));
  const chipAdjustment=chip==="3xc"?receipt.squad.captainXPts:chip==="bboost"?benchIds.reduce((sum,id)=>sum+currentProjection(id),0):0;
  const adjustedProjectedTotal=receiptNumber(receipt.squad.predictedTotal+chipAdjustment);
  const managerActual=Number(firstWeek.points),transferCost=firstWeek.transferCost??0;
  const officialScoringTotal=firstWeek.squad?.reduce((sum,pick)=>sum+(historyPlayerStats(firstWeek,pick.elementId)?.points??0)*pick.multiplier,0);
  const actualBeforeHits=officialScoringTotal??managerActual;
  const signedSquadError=officialPlanMatch?receiptNumber(actualBeforeHits-adjustedProjectedTotal):null;
  const captainStats=historyPlayerStats(firstWeek,receipt.squad.captainId);
  const captain={receiptCaptainId:receipt.squad.captainId,officialCaptainId,effectiveCaptainId,matched:officialCaptainId===null?null:officialCaptainId===receipt.squad.captainId,projectedRaw:receipt.squad.captainXPts,actualRaw:captainStats?.points??null,officialContribution:firstWeek.captainContribution??null};

  const allPointErrors:number[]=[],activePointErrors:number[]=[],activeBias:number[]=[],minuteErrors:number[]=[],startErrors:number[]=[];
  let withinTwo=0;
  for(let eventIndex=0;eventIndex<completedEvents;eventIndex++){
    const week=weekByEvent.get(receipt.eventIds[eventIndex]);
    for(const player of receipt.players){
      const stats=historyPlayerStats(week,player[0]);if(!stats)continue;
      const projected=player[11]?.[eventIndex]??(eventIndex===0?player[4]:null);if(projected===null)continue;
      const error=Math.abs(stats.points-projected);allPointErrors.push(error);
      if(projected>=.5||stats.minutes>0){activePointErrors.push(error);activeBias.push(stats.points-projected);if(error<=2)withinTwo++}
      if(eventIndex===0){minuteErrors.push(Math.abs(stats.minutes-player[5]));startErrors.push(Math.pow((stats.starts>0?1:0)-player[6],2))}
    }
  }
  const population=allPointErrors.length?{rows:allPointErrors.length,activeRows:activePointErrors.length,allPlayerPointsMae:receiptNumber(average(allPointErrors)),activePlayerPointsMae:receiptNumber(average(activePointErrors)),pointsBias:receiptNumber(average(activeBias)),withinTwoPct:receiptNumber(activePointErrors.length?withinTwo/activePointErrors.length*100:0,1),minutesMae:receiptNumber(average(minuteErrors),1),startBrier:receiptNumber(average(startErrors))}:null;
  const playerRows:ProjectionPlayerEvaluationRow[]=receipt.players.flatMap(player=>{
    const stats=historyPlayerStats(firstWeek,player[0]);
    if(!stats)return[];
    const projected=player[4],actual=stats.points,confidence=player[7];
    return[{event:receipt.event,playerId:player[0],teamId:player[12]??null,positionShort:player[13]??null,projectedPoints:projected,actualPoints:actual,error:receiptNumber(Math.abs(actual-projected)),signedError:receiptNumber(actual-projected),expectedMinutes:player[5],actualMinutes:stats.minutes,startProbability:player[6],started:stats.starts>0,confidence,confidenceBand:projectionConfidenceBand(confidence),calibrationGroup:player[14]??null,lowPlContinuityClub:player[15]??null}];
  });

  const transfers=receipt.transfers.slice(0,5).map(row=>{
    let actualPlayerSwing=0,projectedPlayerSwing=0,paired=0,projectionPairs=0;
    const incoming=tupleById.get(row.incomingId),outgoing=tupleById.get(row.outId);
    for(let eventIndex=0;eventIndex<completedEvents;eventIndex++){
      const week=weekByEvent.get(receipt.eventIds[eventIndex]),incomingStats=historyPlayerStats(week,row.incomingId),outgoingStats=historyPlayerStats(week,row.outId);
      if(!incomingStats||!outgoingStats)break;
      actualPlayerSwing+=incomingStats.points-outgoingStats.points;
      const incomingProjected=incoming?.[11]?.[eventIndex]??(eventIndex===0?incoming?.[4]:null),outgoingProjected=outgoing?.[11]?.[eventIndex]??(eventIndex===0?outgoing?.[4]:null);
      if(incomingProjected!==null&&incomingProjected!==undefined&&outgoingProjected!==null&&outgoingProjected!==undefined){projectedPlayerSwing+=incomingProjected-outgoingProjected;projectionPairs++}
      paired++;
    }
    return{rank:row.rank,outId:row.outId,outName:row.outName,incomingId:row.incomingId,incomingName:row.incomingName,completedEvents:paired,horizonEvents:receipt.eventIds.length,projectedPlayerSwing:paired&&projectionPairs===paired?receiptNumber(projectedPlayerSwing):null,actualPlayerSwing:paired?actualPlayerSwing:null,actualNetAfterHit:paired?actualPlayerSwing-row.hitCost:null,projectedFive:row.individualGain5,hitCost:row.hitCost,reviewRequired:row.reviewRequired};
  });
  return{event:receipt.event,modelVersion:receipt.modelVersion,status:"evaluated",completedEvents,horizonEvents:receipt.eventIds.length,managerActual,actualBeforeHits,transferCost,officialPlanMatch,projectedTotal:receipt.squad.predictedTotal,chip,adjustedProjectedTotal,signedSquadError,absoluteSquadError:signedSquadError===null?null:Math.abs(signedSquadError),captain,population,playerRows,transfers};
}

export type AccuracyMetric={rows:number;activeRows:number;pointsMae:number|null;pointsBias:number|null;withinTwoPct:number|null;minutesMae:number|null;startBrier:number|null};

export function aggregateAccuracy(rows:ProjectionPlayerEvaluationRow[]):AccuracyMetric{
  const active=rows.filter(row=>row.projectedPoints>=.5||row.actualMinutes>0);
  return{rows:rows.length,activeRows:active.length,pointsMae:active.length?receiptNumber(average(active.map(row=>row.error))):null,pointsBias:active.length?receiptNumber(average(active.map(row=>row.signedError))):null,withinTwoPct:active.length?receiptNumber(active.filter(row=>row.error<=2).length/active.length*100,1):null,minutesMae:rows.length?receiptNumber(average(rows.map(row=>Math.abs(row.actualMinutes-row.expectedMinutes))),1):null,startBrier:rows.length?receiptNumber(average(rows.map(row=>Math.pow((row.started?1:0)-row.startProbability,2)))):null};
}

export type TransferAccuracyMetric={rows:number;projectedAverage:number|null;actualAverage:number|null;netAfterHitAverage:number|null;positivePct:number|null};

export function aggregateTransferAccuracy(rows:ProjectionTransferEvaluation[]):TransferAccuracyMetric{
  const completed=rows.filter(row=>row.completedEvents>0&&row.actualPlayerSwing!==null&&row.actualNetAfterHit!==null);
  const projected=completed.filter(row=>row.projectedPlayerSwing!==null);
  return{rows:completed.length,projectedAverage:projected.length?receiptNumber(average(projected.map(row=>row.projectedPlayerSwing!))):null,actualAverage:completed.length?receiptNumber(average(completed.map(row=>row.actualPlayerSwing!))):null,netAfterHitAverage:completed.length?receiptNumber(average(completed.map(row=>row.actualNetAfterHit!))):null,positivePct:completed.length?receiptNumber(completed.filter(row=>row.actualNetAfterHit!>0).length/completed.length*100,1):null};
}

export function ModelVersionPanel(){
  const current=modelRelease(PROJECTION_MODEL_VERSION);
  return <section className="model-version-panel">
    <header><div><span>MODEL VERSION</span><h2>{current?`${current.short} · ${current.title}`:PROJECTION_MODEL_VERSION}</h2><p>Every pre-deadline receipt keeps the exact model version that produced it. Historical accuracy is calculated within that version only—never pooled across changed formulas.</p></div><b>CURRENT</b></header>
    <div className="model-release-grid">{MODEL_RELEASES.map(release=><article className={release.version===PROJECTION_MODEL_VERSION?"current":""} key={release.version}><div><span>{release.short}</span><small>{release.released}</small></div><h3>{release.title}</h3><ul>{release.changes.map(change=><li key={change}>{change}</li>)}</ul><code>{release.version}</code></article>)}</div>
  </section>;
}

export function PointsModel({data}:{data:FplData}){
  const events=futureEvents(data,5),first=events[0]?.id;const[q,setQ]=useState("");const[selected,setSelected]=useState<number|null>(null);const[technical,setTechnical]=useState(false);
  const players=data.players.filter(p=>(`${p.name} ${p.teamName}`).toLowerCase().includes(q.toLowerCase())).sort((a,b)=>b.epNext-a.epNext).slice(0,10),p=data.players.find(x=>x.id===(selected??players[0]?.id))??data.players[0],m=projectionMetrics(p,first,data.fixtures,first),calibration=playerCalibrationProfile(p);
  const appearance=(1-m.sixtyProbability)*m.startProbability+m.sixtyProbability*2,goalPts=m.xG*(p.positionShort==="FWD"?4:p.positionShort==="MID"?5:6),assistPts=m.xA*3,cleanPts=m.cleanSheetProbability*(p.positionShort==="MID"?1:["GKP","DEF"].includes(p.positionShort)?4:0)*m.sixtyProbability,other=Math.max(0,m.xPts-appearance-goalPts-assistPts-cleanPts-m.bonus),confidence=projectionConfidenceBand(m.confidence);
  let locks:any[]=[];try{locks=JSON.parse(localStorage.getItem("fpl-edge-locks")||"[]")}catch{}
  return <div className="coach-page">
    <section className="model-trust"><div><span>HOW PROJECTIONS WORK</span><h2>Transparent by default. Technical when you want it.</h2><p>Expected points combine expected minutes, team and opponent strength, xG/xA, penalties and set pieces, clean-sheet probability, defensive contributions, home advantage, role and official availability.</p></div><button onClick={()=>setTechnical(x=>!x)}>{technical?"Hide technical detail":"Open technical detail"}</button>{technical&&<div className="technical-note"><b>Technical method</b><p>Players are assigned to an explicit Premier League evidence group. Established PL history uses normal shrinkage; limited history receives stronger shrinkage; players with no genuine PL prior start from a position baseline and learn more slowly from early current-season matches.</p><p>Club-level PL continuity lowers the projection-evidence ceiling when a roster has little proven top-flight evidence. It never substitutes Championship output as Premier League data.</p></div>}</section>
    <section className="model-picker"><input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search a player…"/><div>{players.map(x=><button className={x.id===p.id?"active":""} onClick={()=>setSelected(x.id)} key={x.id}>{x.name}<small>{x.teamShort}</small></button>)}</div></section>
    <section className="projection-explainer"><header><div><span>{p.teamName} · {p.position} · £{p.price.toFixed(1)}m</span><h2>{p.name} — {m.xPts.toFixed(1)} xPts</h2></div><b className={confidence.toLowerCase()}>Projection evidence: {confidence}</b></header><div>{[["Appearance",appearance],["Goals",goalPts],["Assists",assistPts],["Clean sheet",cleanPts],["Bonus",m.bonus],["Other",other]].map(([label,value])=><article key={String(label)}><span>{label}</span><b>{Number(value).toFixed(2)}</b><i><em style={{width:`${clamp(Number(value)/Math.max(.1,m.xPts)*100)}%`}}/></i></article>)}</div><footer><span>{Math.round(m.expectedMinutes)} xMins</span><span>{Math.round(m.startProbability*100)}% start</span><span>{m.penaltyRole?"Penalties":"No confirmed pens"}</span><span>{m.setPieceRole?"Set pieces":"No confirmed set pieces"}</span></footer></section>
    <section className="calibration-card"><header><div><span>PLAYER EVIDENCE CLASS</span><h2>{calibration.label}</h2></div><b>{Math.round(m.confidence*100)}% projection evidence</b></header><div><p><span>Prior PL sample</span><b>{p.priorMinutes.toLocaleString()} min</b><small>{calibration.hasPremierLeaguePrior?`${p.priorSeason??"Prior season"} · ${p.priorCompetition??"Premier League"}`:"No non-PL statistics substituted"}</small></p><p><span>Current PL sample</span><b>{p.minutes.toLocaleString()} min</b><small>{Math.round((m.currentEvidenceWeight??0)*100)}% current-rate weight</small></p><p><span>Projection-evidence ceiling</span><b>{Math.round((m.confidenceCap??1)*100)}%</b><small>rises only when real PL evidence supports it</small></p><p><span>Club PL continuity</span><b>{Math.round((p.teamPlPriorCoverage??0)*100)}%</b><small>{calibration.lowPlContinuityClub?"Promoted / low-continuity context":"Established roster context"}</small></p></div>{calibration.group!=="established-pl"&&<footer>This player is deliberately prevented from receiving established-player certainty. The transfer rank consumes the lower projection evidence; warnings explain the evidence gap.</footer>}</section>
    <section className="model-reality"><header><div><span>MODEL VS REALITY</span><h2>Every locked plan becomes an audit trail.</h2></div><strong>{locks.length}<small>projection snapshots</small></strong></header>{locks.length?<div>{locks.slice(-5).reverse().map((l:any)=><article key={l.event}><b>GW{l.event}</b><span>Projected {l.predicted} pts</span><em>Actual result appears after the gameweek is finished</em></article>)}</div>:<p>Lock a team in Final Check to start tracking projected points, actual points, error and rolling model accuracy. No backtest numbers are fabricated.</p>}</section>
  </div>;
}

type EvaluationRow={lock:LockRecord;evaluation:ProjectionEvaluation};

export function ModelAudit({data,revision,go}:{data:FplData;revision:number;go?:(v:View)=>void}){
  const[rows,setRows]=useState<{lock:LockRecord;evaluation:ProjectionEvaluation}[]>([]);
  const[loading,setLoading]=useState(false);const[error,setError]=useState("");const[refreshToken,setRefreshToken]=useState(0);
  useEffect(()=>{let cancelled=false;const run=async()=>{let locks:LockRecord[]=[];try{locks=JSON.parse(localStorage.getItem("fpl-edge-locks")||"[]")}catch{}const entry=localStorage.getItem("fpl-edge-entry");let weeks:HistoryWeek[]=[];setLoading(!!entry);setError("");if(entry)try{const response=await fetch(`/api/fpl/history?entry=${entry}`,{cache:"no-store"});const json=await response.json();if(!response.ok)throw new Error(json.error||"Could not load official history");weeks=json.weeks||[]}catch(e){if(!cancelled)setError(e instanceof Error?e.message:"Could not load official history")}finally{if(!cancelled)setLoading(false)}const mapped=locks.map(lock=>({lock,evaluation:evaluateProjectionReceipt(lock,weeks)})).sort((a,b)=>b.lock.event-a.lock.event);if(!cancelled)setRows(mapped)};run();return()=>{cancelled=true}},[revision,refreshToken]);
  const refresh=()=>setRefreshToken(value=>value+1);
  const noHistory=!rows.length&&!loading&&!error;
  return <>{noHistory&&go&&<EmptyDeskState eyebrow="DECISION HISTORY" title="No graded forecasts yet" lede="Every locked plan is graded against official results once its gameweek finishes. Nothing is shown until there is a real receipt." steps={["Open Final check and lock your team before the deadline","The gameweek plays out","Your forecast is graded here against the official result"]} actionLabel="Open Final check" onAction={()=>go("deadline")}/>}<AccuracyDashboard data={data} rows={rows}/><DecisionSnapshots data={data} rows={rows} loading={loading} error={error} refresh={refresh}/></>;
}

function AccuracyDashboard({data,rows,weeks=[]}:{data:FplData;rows:EvaluationRow[];weeks?:HistoryWeek[]}){
  const allEvaluated=rows.filter(row=>row.evaluation.status==="evaluated");
  const[selectedVersion,setSelectedVersion]=useState(PROJECTION_MODEL_VERSION);
  const groupedVersions=groupByModelVersion(allEvaluated,row=>row.evaluation.modelVersion);
  const availableVersions=[PROJECTION_MODEL_VERSION,...[...groupedVersions.keys()].filter(version=>version!==PROJECTION_MODEL_VERSION)];
  const evaluated=comparableModelRows(allEvaluated,selectedVersion,row=>row.evaluation.modelVersion);
  const playerRows=evaluated.flatMap(row=>row.evaluation.playerRows);
  const overall=aggregateAccuracy(playerRows);
  const captainPairs=evaluated.flatMap(row=>{const captain=row.evaluation.captain;return captain?.actualRaw===null||captain?.actualRaw===undefined?[]:[{event:row.evaluation.event,projected:captain.projectedRaw,actual:captain.actualRaw,error:Math.abs(captain.actualRaw-captain.projectedRaw)}]});
  const captainMae=captainPairs.length?average(captainPairs.map(row=>row.error)):null;
  const transferRows=evaluated.flatMap(row=>row.evaluation.transfers);
  const transfer=aggregateTransferAccuracy(transferRows),topTransfer=aggregateTransferAccuracy(transferRows.filter(row=>row.rank===1));
  const grouped=(keyOf:(row:ProjectionPlayerEvaluationRow)=>string,labelOf:(key:string)=>string)=>{
    const map=new Map<string,ProjectionPlayerEvaluationRow[]>();
    playerRows.forEach(row=>{const key=keyOf(row);map.set(key,[...(map.get(key)??[]),row])});
    return[...map].map(([key,values])=>({key,label:labelOf(key),metric:aggregateAccuracy(values)}));
  };
  const byPosition=grouped(row=>row.positionShort??"LEGACY",key=>key==="LEGACY"?"Legacy / unknown":key).sort((a,b)=>["GKP","DEF","MID","FWD","LEGACY"].indexOf(a.key)-["GKP","DEF","MID","FWD","LEGACY"].indexOf(b.key));
  const byConfidence=grouped(row=>row.confidenceBand,key=>key).sort((a,b)=>["High","Medium","Low"].indexOf(a.key)-["High","Medium","Low"].indexOf(b.key));
  const calibrationLabels:Record<string,string>={"established-pl":"Established PL prior","limited-pl":"Limited PL prior","no-pl-prior":"No genuine PL prior","current-pl-established":"Established this PL season","LEGACY":"Legacy / unknown"};
  const byCalibration=grouped(row=>row.calibrationGroup??"LEGACY",key=>calibrationLabels[key]??key).sort((a,b)=>["established-pl","limited-pl","no-pl-prior","current-pl-established","LEGACY"].indexOf(a.key)-["established-pl","limited-pl","no-pl-prior","current-pl-established","LEGACY"].indexOf(b.key));
  const teamName=new Map(data.teams.map(team=>[String(team.id),team.name]));
  const byClub=grouped(row=>row.teamId===null?"LEGACY":String(row.teamId),key=>key==="LEGACY"?"Legacy / unknown":teamName.get(key)??`Team ${key}`).sort((a,b)=>b.metric.activeRows-a.metric.activeRows||((b.metric.pointsMae??0)-(a.metric.pointsMae??0)));
  const byEvent=grouped(row=>String(row.event),key=>`GW${key}`).sort((a,b)=>Number(a.key)-Number(b.key));
  const byMinutesRisk=(()=>{
    const map=new Map<string,ProjectionPlayerEvaluationRow[]>();
    playerRows.forEach(row=>{const key=minutesRiskBand(row.startProbability);map.set(key,[...(map.get(key)??[]),row])});
    return["Secure","Moderate","Risky"].filter(key=>map.has(key)).map(key=>({key,label:key==="Secure"?"Secure minutes (≥80% start)":key==="Moderate"?"Moderate minutes (50–79%)":"Risky minutes (<50%)",metric:aggregateAccuracy(map.get(key)!)}));
  })();
  const horizonRows=evaluated.flatMap(({lock,evaluation})=>{
    const receipt=lock.receipt;
    if(!receipt||evaluation.status!=="evaluated"||evaluation.completedEvents<1)return[];
    const completedEventIds=receipt.eventIds.slice(0,evaluation.completedEvents);
    const actualByEventPlayer=new Map<string,number>();
    for(const eventId of completedEventIds){
      const week=weeks.find(item=>item.event===eventId&&!item.unavailable);
      if(!week?.playerStats)continue;
      for(const [playerId,stats] of Object.entries(week.playerStats))actualByEventPlayer.set(`${eventId}:${Number(playerId)}`,stats.points);
    }
    // Fall back to one-GW actuals from evaluation rows when history weeks lack multi-event stats.
    if(!actualByEventPlayer.size)evaluation.playerRows.forEach(row=>actualByEventPlayer.set(`${row.event}:${row.playerId}`,row.actualPoints));
    return horizonAccuracyRows({event:evaluation.event,receiptPlayers:receipt.players as any,actualByEventPlayer,completedEventIds});
  });
  const byHorizon=buildAccuracyReport(selectedVersion,playerRows as AccuracyPlayerRow[],evaluated.length,horizonRows).byHorizon;
  const fmtMetric=(value:number|null,places=2)=>value===null?"—":value.toFixed(places);
  const versionSummaries=availableVersions.map(version=>{
    const versionRows=groupedVersions.get(version)??[];
    const metric=aggregateAccuracy(versionRows.flatMap(row=>row.evaluation.playerRows));
    const captains=versionRows.flatMap(row=>{const captain=row.evaluation.captain;return captain?.actualRaw===null||captain?.actualRaw===undefined?[]:[Math.abs(captain.actualRaw-captain.projectedRaw)]});
    const top=aggregateTransferAccuracy(versionRows.flatMap(row=>row.evaluation.transfers.filter(route=>route.rank===1)));
    return{version,rows:versionRows.length,metric,captainMae:captains.length?average(captains):null,topGain:top.netAfterHitAverage};
  });
  const SliceTable=({title,items}:{title:string;items:ReturnType<typeof grouped>})=><section className="accuracy-slice"><header><span>{title}</span><small>xPts uses active rows · minutes/start use all rows</small></header><div className="accuracy-table"><div><b>GROUP</b><b>N</b><b>xPTS MAE</b><b>BIAS</b><b>±2 PTS</b><b>xMINS MAE</b><b>BRIER</b></div>{items.map(item=><div key={item.key}><strong>{item.label}</strong><span>{item.metric.activeRows}<small> / {item.metric.rows}</small></span><span>{fmtMetric(item.metric.pointsMae)}</span><span>{item.metric.pointsBias!==null&&item.metric.pointsBias>0?"+":""}{fmtMetric(item.metric.pointsBias)}</span><span>{item.metric.withinTwoPct===null?"—":`${item.metric.withinTwoPct.toFixed(1)}%`}</span><span>{fmtMetric(item.metric.minutesMae,1)}</span><span>{fmtMetric(item.metric.startBrier,3)}</span></div>)}</div></section>;
  return <section className="accuracy-dashboard">
    <header><div><span>MODEL ACCURACY</span><h2>Measured forecasts, not a marketing score.</h2><p>One-gameweek-ahead player forecasts are compared with official finished-event data. Lower MAE and Brier scores are better; positive bias means actual points exceeded the forecast.</p></div><strong>{evaluated.length}<small>evaluated gameweeks</small></strong></header>
    <nav className="model-version-tabs" aria-label="Accuracy model version">{availableVersions.map(version=><button className={selectedVersion===version?"active":""} onClick={()=>setSelectedVersion(version)} key={version}><span>{modelDisplayName(version)}</span><small>{groupedVersions.get(version)?.length??0} evaluated GW</small></button>)}</nav>
    <p className="model-comparability-note"><b>{modelDisplayName(selectedVersion)}</b> only. Metrics below never combine forecasts made by different model generations.</p>
    {versionSummaries.length>1&&<section className="version-comparison"><header><span>VERSION COMPARISON</span><small>Separate cohorts · lower error is better · fewer than 5 GWs is early evidence</small></header><div>{versionSummaries.map(summary=><button className={selectedVersion===summary.version?"active":""} onClick={()=>setSelectedVersion(summary.version)} key={summary.version}><strong>{modelDisplayName(summary.version)}</strong><span>{summary.rows} GW{summary.rows===1?"":"s"}{summary.rows<5?" · early sample":""}</span><dl><div><dt>xPts MAE</dt><dd>{fmtMetric(summary.metric.pointsMae)}</dd></div><div><dt>Start Brier</dt><dd>{fmtMetric(summary.metric.startBrier,3)}</dd></div><div><dt>Captain MAE</dt><dd>{fmtMetric(summary.captainMae)}</dd></div><div><dt>Top route</dt><dd>{summary.topGain===null?"—":`${summary.topGain>=0?"+":""}${summary.topGain.toFixed(2)}`}</dd></div></dl></button>)}</div></section>}
    {!playerRows.length?<div className="accuracy-empty"><b>No calibration sample yet.</b><p>Final Check auto-stores a pre-deadline snapshot each GW (and Lock This Team refreshes it). Connect your FPL Team ID; this dashboard activates after FPL publishes the finished gameweek. Public <code>/api/fpl/accuracy</code> keeps <code>report: null</code> on purpose (no private receipts server-side) — History MAE here is the graded surface.</p></div>:<>
      <div className="accuracy-kpis">
        <article><span>xPTS MAE</span><b>{fmtMetric(overall.pointsMae)}</b><small>{overall.activeRows} active player forecasts</small></article>
        <article><span>START BRIER</span><b>{fmtMetric(overall.startBrier,3)}</b><small>0 is perfect · {overall.rows} probabilities</small></article>
        <article><span>xMINS MAE</span><b>{fmtMetric(overall.minutesMae,1)}</b><small>minutes per player</small></article>
        <article><span>CAPTAIN MAE</span><b>{captainMae===null?"—":captainMae.toFixed(2)}</b><small>{captainPairs.length} raw-points forecasts</small></article>
        <article><span>TOP ROUTE GAIN</span><b>{topTransfer.netAfterHitAverage===null?"—":`${topTransfer.netAfterHitAverage>=0?"+":""}${topTransfer.netAfterHitAverage.toFixed(2)}`}</b><small>{topTransfer.rows} completed #1 routes</small></article>
        <article><span>ALL ROUTES POSITIVE</span><b>{transfer.positivePct===null?"—":`${transfer.positivePct.toFixed(1)}%`}</b><small>{transfer.rows} frozen route observations</small></article>
      </div>
      {evaluated.length<5&&<p className="accuracy-warning"><b>Small sample:</b> {evaluated.length} evaluated gameweek{evaluated.length===1?"":"s"}. Treat these measurements as early calibration evidence, not proof of long-run accuracy.</p>}
      <SliceTable title="GAMEWEEK TREND" items={byEvent}/>
      <SliceTable title="BY PRIOR-EVIDENCE GROUP" items={byCalibration}/>
      <div className="accuracy-breakdowns"><SliceTable title="BY POSITION" items={byPosition}/><SliceTable title="BY MINUTES RISK" items={byMinutesRisk}/></div>
      <div className="accuracy-breakdowns"><SliceTable title="BY PROJECTION EVIDENCE" items={byConfidence}/><SliceTable title="BY HORIZON" items={byHorizon}/></div>
      <SliceTable title="BY CLUB" items={byClub}/>
      <section className="accuracy-transfer"><header><div><span>TRANSFER RECOMMENDATION GAINS</span><h3>Frozen routes through completed horizon weeks</h3></div><small>Recommendations are evaluated as scenarios, not claimed as transfers the manager made.</small></header><div><p><span>All-route forecast</span><b>{transfer.projectedAverage===null?"—":`${transfer.projectedAverage>=0?"+":""}${transfer.projectedAverage.toFixed(2)}`}</b></p><p><span>All-route actual</span><b>{transfer.actualAverage===null?"—":`${transfer.actualAverage>=0?"+":""}${transfer.actualAverage.toFixed(2)}`}</b></p><p><span>After-hit actual</span><b>{transfer.netAfterHitAverage===null?"—":`${transfer.netAfterHitAverage>=0?"+":""}${transfer.netAfterHitAverage.toFixed(2)}`}</b></p><p><span>Top-route positive</span><b>{topTransfer.positivePct===null?"—":`${topTransfer.positivePct.toFixed(1)}%`}</b></p></div></section>
    </>}
  </section>;
}

function DecisionSnapshots({data,rows,loading,error,refresh}:{data:FplData;rows:EvaluationRow[];loading:boolean;error:string;refresh:()=>void}){
  const allEvaluated=rows.filter(row=>row.evaluation.status==="evaluated");
  const evaluated=allEvaluated.filter(row=>row.evaluation.modelVersion===PROJECTION_MODEL_VERSION);
  const archivedEvaluated=allEvaluated.length-evaluated.length;
  const squadErrors=evaluated.flatMap(row=>row.evaluation.absoluteSquadError===null?[]:[row.evaluation.absoluteSquadError]);
  const playerMaes=evaluated.flatMap(row=>row.evaluation.population?[row.evaluation.population.activePlayerPointsMae]:[]);
  const captainErrors=evaluated.flatMap(row=>{const captain=row.evaluation.captain;return captain?.actualRaw===null||captain?.actualRaw===undefined?[]:[Math.abs(captain.actualRaw-captain.projectedRaw)]});
  const squadMae=squadErrors.length?average(squadErrors):null,playerMae=playerMaes.length?average(playerMaes):null,captainMae=captainErrors.length?average(captainErrors):null;
  const nameOf=(id:number|null|undefined)=>data.players.find(player=>player.id===id)?.name??(id?`Player ${id}`:"—");
  return <section className="decision-snapshots">
    <header><div><span>AUTOMATIC POST-GW EVALUATION</span><h2>Every forecast is graded against official results.</h2><p>Evaluations appear after FPL marks the gameweek finished. Changed official teams are flagged instead of being scored against a plan you did not submit.</p></div><button onClick={refresh} disabled={loading}>{loading?"Checking…":"Refresh evaluations"}</button></header>
    <div className="evaluation-kpis">
      <article><span>CURRENT MODEL</span><b>{evaluated.length}</b><small>evaluated · {archivedEvaluated} archived separately</small></article>
      <article><span>SQUAD MAE</span><b>{squadMae===null?"—":squadMae.toFixed(1)}</b><small>matching official plans only</small></article>
      <article><span>ACTIVE-PLAYER MAE</span><b>{playerMae===null?"—":playerMae.toFixed(2)}</b><small>xPts error per player-event</small></article>
      <article><span>CAPTAIN MAE</span><b>{captainMae===null?"—":captainMae.toFixed(2)}</b><small>raw points vs forecast</small></article>
    </div>
    <p className="model-comparability-note"><b>{modelDisplayName(PROJECTION_MODEL_VERSION)}</b> only in the summary above. All archived receipts remain visible below with their original version label.</p>
    {error&&<p className="evaluation-error">Official evaluation refresh failed: {error}</p>}
    {rows.length?<div className="evaluation-list">{rows.map(({lock,evaluation})=>{
      const receipt=lock.receipt,population=evaluation.population,captain=evaluation.captain;
      const statusLabel=evaluation.status==="evaluated"?evaluation.officialPlanMatch?"OFFICIAL PLAN MATCHED":"OFFICIAL PLAN CHANGED":evaluation.status==="pending"?"WAITING FOR FINAL RESULT":evaluation.status==="unavailable"?"OFFICIAL RESULT UNAVAILABLE":"LEGACY SNAPSHOT";
      const statusTone=evaluation.status==="evaluated"&&evaluation.officialPlanMatch?"matched":evaluation.status==="evaluated"&&!evaluation.officialPlanMatch?"changed":"pending";
      const captainOutcome=!captain||captain.actualRaw===null?"No result":`${captain.actualRaw} raw · ${captain.officialContribution??"—"} official contribution${captain.matched===false?` · official captain ${nameOf(captain.officialCaptainId)}`:""}${captain.effectiveCaptainId!==captain.officialCaptainId?` · armband passed to ${nameOf(captain.effectiveCaptainId)}`:""}`;
      return <article className="evaluation-card" key={`${lock.event}-${lock.lockedAt}`}>
        <header><div><span>GW{lock.event} · {receipt?.modelVersion??"legacy"}</span><h3>{evaluation.status==="evaluated"?`Forecast review for GW${lock.event}`:`GW${lock.event} receipt`}</h3></div><b className={statusTone}>{statusLabel}</b></header>
        <div className="evaluation-scoreline">
          <p><span>Projected</span><b>{evaluation.adjustedProjectedTotal.toFixed(1)}</b><small>{evaluation.chip?`${evaluation.chip} adjustment included`:"standard scoring"}</small></p>
          <i>→</i>
          <p><span>Official points</span><b>{evaluation.managerActual??"—"}</b><small>{evaluation.status==="pending"?"pending":evaluation.officialPlanMatch===false?"different submitted plan":evaluation.transferCost?`${evaluation.actualBeforeHits} before −${evaluation.transferCost} transfer hit`:"finished result"}</small></p>
          <p><span>Signed error</span><b>{evaluation.signedSquadError===null?"—":`${evaluation.signedSquadError>0?"+":""}${evaluation.signedSquadError.toFixed(1)}`}</b><small>{evaluation.signedSquadError===null?"not graded":evaluation.signedSquadError>0?"model underprojected":"model overprojected"}</small></p>
        </div>
        {evaluation.status==="evaluated"&&evaluation.officialPlanMatch===false&&<p className="plan-divergence">The official squad, XI or captaincy differed from this receipt. Official points are shown for context, but no squad-total model error is calculated.</p>}
        {evaluation.status==="evaluated"&&<div className="evaluation-detail-grid">
          <p><span>Captain forecast</span><b>{captain?`${nameOf(captain.receiptCaptainId)} · ${captain.projectedRaw.toFixed(1)} xPts`:"—"}</b><small>{captainOutcome}</small></p>
          <p><span>Active-player MAE</span><b>{population?.activePlayerPointsMae.toFixed(2)??"—"}</b><small>{population?`${population.activeRows} meaningful player-events`:"No player data"}</small></p>
          <p><span>Expected-minutes MAE</span><b>{population?.minutesMae.toFixed(1)??"—"}</b><small>first-event minutes forecast</small></p>
          <p><span>Start Brier</span><b>{population?.startBrier.toFixed(3)??"—"}</b><small>lower is better · 0 is perfect</small></p>
          <p><span>Within ±2 points</span><b>{population?`${population.withinTwoPct.toFixed(1)}%`:"—"}</b><small>active player-event forecasts</small></p>
          <p><span>Points bias</span><b>{population?`${population.pointsBias>0?"+":""}${population.pointsBias.toFixed(2)}`:"—"}</b><small>{population?.pointsBias&&population.pointsBias>0?"underprojecting":"negative means overprojecting"}</small></p>
        </div>}
        {evaluation.transfers.length>0&&<section className="route-evaluation"><header><span>FROZEN TRANSFER ROUTES</span><small>{evaluation.completedEvents}/{evaluation.horizonEvents} horizon gameweeks complete</small></header>{evaluation.transfers.slice(0,3).map(route=><div key={`${route.rank}-${route.outName}-${route.incomingName}`}><b>#{route.rank} {route.outName} → {route.incomingName}</b><span>Forecast through {route.completedEvents}: <strong>{route.projectedPlayerSwing===null?"—":`${route.projectedPlayerSwing>=0?"+":""}${route.projectedPlayerSwing.toFixed(1)}`}</strong></span><span>Actual through {route.completedEvents}: <strong>{route.actualPlayerSwing===null?"—":`${route.actualPlayerSwing>=0?"+":""}${route.actualPlayerSwing}`}</strong></span><span>After hit: <strong>{route.actualNetAfterHit===null?"—":`${route.actualNetAfterHit>=0?"+":""}${route.actualNetAfterHit}`}</strong></span><small>Original 5-GW player-swing forecast {route.projectedFive>=0?"+":""}{route.projectedFive.toFixed(1)}{route.reviewRequired?" · review was required":""}</small></div>)}</section>}
        <footer>{receipt?`${receipt.players.length} frozen players · ${receipt.transfers.length} routes · ${receipt.squad.benchIds?.length===4?"bench order frozen · ":""}${receipt.playerEncoding} · locked ${new Date(lock.lockedAt).toLocaleString()}`:`Legacy lock from ${new Date(lock.lockedAt).toLocaleString()} — detailed calibration was not captured.`}</footer>
      </article>})}</div>:<div className="history-empty"><b>No projection receipts yet.</b><p>Use Final Check and lock your team before the deadline. After the gameweek finishes, this page will automatically grade the squad forecast, player projections, captaincy and transfer routes.</p></div>}
  </section>
}
// Views the shell's Page() lazy-loads as single units (they compose several panels).
export function FixturesView({data}:{data:FplData}){return <div className="coach-page"><TeamQualityPanel data={data}/><TeamQualityFixtures data={data}/><LineupIntelligencePanel data={data}/></div>}
export function ModelView({data}:{data:FplData}){return <div className="coach-page"><ModelVersionPanel/><TeamQualityPanel data={data}/><PointsModel data={data}/></div>}
export function HistoryView({data,revision,go}:{data:FplData;revision:number;go?:(v:View)=>void}){return <div className="coach-page"><ModelAudit data={data} revision={revision} go={go}/><LiveHistory officialData={data}/></div>}
export function ChipsView(){return <><LiveChips/><ChipPortfolioPanel/></>}

