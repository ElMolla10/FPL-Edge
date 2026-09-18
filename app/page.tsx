"use client";

import { useEffect, useMemo, useState } from "react";
import CoachApp from "./components/CoachApp";
import { formatSeasonPassPrice } from "./lib/season-pass";
import { fetchFplData, futureEvents, playerProjection } from "./lib/fpl";
import type { FplData, FplPlayer } from "./lib/fpl";

type ExampleDesk = {
  name: string;
  deadline: string;
  total: number | null;
  captain: FplPlayer | null;
  captainPoints: number | null;
};

// No team is connected on the public homepage, so this is not a manager's XI. It is the model's
// best legal formation from this deadline's live player pool, with the captain counted twice the
// way the desk's projected total does. Budget and a real 15-man squad are not applied. The card
// says Example for that reason.
function exampleDesk(data: FplData): ExampleDesk | null {
  const event = futureEvents(data, 1)[0];
  if (!event) return null;
  const scores = new Map<number, number>();
  for (const player of data.players) scores.set(player.id, playerProjection(player, event.id, data.fixtures, event.id));
  const limit = data.rules?.teamLimit || 3;
  const ranked = data.players
    .filter((player) => player.status !== "u" && player.chance !== 0)
    .sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0));
  const formations: [number, number, number][] = [[3, 4, 3], [3, 5, 2], [4, 3, 3], [4, 4, 2], [4, 5, 1], [5, 2, 3], [5, 3, 2], [5, 4, 1]];
  const pick = (position: string, count: number, used: Set<number>, clubs: Map<number, number>) => {
    const chosen: FplPlayer[] = [];
    for (const player of ranked) {
      if (player.positionShort !== position || used.has(player.id)) continue;
      const club = clubs.get(player.teamId) ?? 0;
      if (club >= limit) continue;
      chosen.push(player);
      used.add(player.id);
      clubs.set(player.teamId, club + 1);
      if (chosen.length === count) break;
    }
    return chosen;
  };
  let best: { total: number; captain: FplPlayer | null } = { total: -1, captain: null };
  for (const [def, mid, fwd] of formations) {
    const used = new Set<number>();
    const clubs = new Map<number, number>();
    const xi = [...pick("GKP", 1, used, clubs), ...pick("DEF", def, used, clubs), ...pick("MID", mid, used, clubs), ...pick("FWD", fwd, used, clubs)];
    if (xi.length !== 11) continue;
    const captain = xi.reduce((top, player) => ((scores.get(player.id) ?? 0) > (scores.get(top.id) ?? 0) ? player : top));
    const total = xi.reduce((sum, player) => sum + (scores.get(player.id) ?? 0), 0) + (scores.get(captain.id) ?? 0);
    if (total > best.total) best = { total, captain };
  }
  return {
    name: event.name,
    deadline: event.deadline,
    total: best.captain ? best.total : null,
    captain: best.captain,
    captainPoints: best.captain ? scores.get(best.captain.id) ?? null : null,
  };
}

function countdown(deadline: string, now: number) {
  const total = Math.max(0, Date.parse(deadline) - now);
  if (!Number.isFinite(total)) return "";
  const days = Math.floor(total / 86400000);
  const hours = Math.floor(total / 3600000) % 24;
  const minutes = Math.floor(total / 60000) % 60;
  const seconds = Math.floor(total / 1000) % 60;
  return `${days ? `${days}d ` : ""}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export default function Home() {
  const [appMode, setAppMode] = useState<null | "demo" | "signin">(null);
  const [data, setData] = useState<FplData | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("checkout") === "return") window.location.replace("/pay?checkout=return");
    if (params.get("app") === "1") setAppMode("demo");
  }, []);
  useEffect(() => {
    if (appMode || new URLSearchParams(window.location.search).get("app") === "1") return;
    let cancel = false;
    fetchFplData().then((next) => { if (!cancel) setData(next); }).catch(() => {});
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    const onScroll = () => setScrolled(window.scrollY > 0);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancel = true;
      window.clearInterval(tick);
      window.removeEventListener("scroll", onScroll);
    };
  }, [appMode]);
  const desk = useMemo(() => {
    if (!data) return null;
    try { return exampleDesk(data); } catch { return null; }
  }, [data]);
  if (appMode) return <CoachApp onBack={() => setAppMode(null)} startAuth={appMode === "signin"} />;

  const clock = desk ? countdown(desk.deadline, now) : "";
  const openDesk = () => setAppMode("demo");
  const points = (value: number | null) => value === null ? "—" : value.toFixed(1);

  return <main className="paper">
    <header className={scrolled ? "paper-header is-scrolled" : "paper-header"}>
      <div className="paper-wrap paper-header-inner">
        <a className="paper-wordmark" href="/" aria-label="FPL Edge home">FPL Edge</a>
        <a className="paper-signin" href="/signin?return_to=%2F%3Fapp%3D1">Sign in</a>
      </div>
    </header>
    <div className="paper-wrap">
      <section className="paper-hero">
        <div className="paper-copy">
          {desk?.name ? <p className="paper-kicker">{desk.name}</p> : null}
          <h1>This week&apos;s move.</h1>
          <p className="paper-lead">A lineup, a captain, and whether to transfer. Free this gameweek.</p>
          <div className="paper-hero-actions">
            <button type="button" className="paper-btn paper-open" onClick={openDesk}>Check your FPL team</button>
            <a className="paper-signin" href="/signin?return_to=%2F%3Fapp%3D1">Sign in</a>
          </div>
        </div>
        <article className="paper-card" aria-label="Example decision">
          <div className="paper-card-top">
            <span className="paper-live"><i aria-hidden="true" />This gameweek</span>
            <span className="paper-clock">{clock || "—"}</span>
          </div>
          <p className="paper-card-label">Projected XI</p>
          <p className="paper-card-number">{points(desk?.total ?? null)}</p>
          <p className="paper-call">Save the transfer.</p>
          <p className="paper-why">A connected squad is what makes a move worth more than rolling.</p>
          <div className="paper-captain">
            <div>
              <b>{desk?.captain?.name ?? "—"}</b>
              <span>{desk?.captain ? `${desk.captain.teamShort} · ${points(desk.captainPoints)} projected` : "Until a team is connected"}</span>
            </div>
            <span className="paper-c" aria-label="Captain">C</span>
          </div>
          <p className="paper-example">Example, until you connect a team.</p>
        </article>
      </section>

      <section className="paper-section">
        <h2>What the desk answers</h2>
        <div className="paper-row"><span className="paper-label">Transfer</span><p>Whether to roll or move, and the gain if you do.</p></div>
        <div className="paper-row"><span className="paper-label">Captain</span><p>One name, and why not the other.</p></div>
        <div className="paper-row"><span className="paper-label">Lineup</span><p>The starting XI, including who to bench.</p></div>
      </section>

      <section className="paper-section">
        <h2>Free this week</h2>
        <div className="paper-price">
          <article className="paper-tier paper-free">
            <p className="paper-label">Free</p>
            <p className="paper-amount">0 EGP</p>
            <p className="paper-term">This gameweek only.</p>
            <ul className="paper-lines">
              <li>One active team</li>
              <li>This gameweek&apos;s projection</li>
              <li>Lineup and captain</li>
              <li>One transfer call</li>
            </ul>
          </article>
          <article className="paper-tier paper-pass">
            <p className="paper-label">Season pass</p>
            <p className="paper-amount">{formatSeasonPassPrice()}</p>
            <ul className="paper-lines">
              <li>One time.</li>
              <li>Through 31 May 2027.</li>
              <li>The same desk for every deadline after this one.</li>
            </ul>
            <div className="paper-pass-btn"><a className="paper-btn" href="/pay">Get the season pass</a></div>
          </article>
        </div>
        <p className="paper-note">Read only. We never ask for your FPL password. You make the move on FPL yourself.</p>
      </section>

      <footer className="paper-footer">
        <span className="paper-wordmark">FPL Edge</span>
        <p>Independent. Not affiliated with the Premier League.</p>
        <span>2026</span>
      </footer>
    </div>
    <div className="paper-dock">
      <button type="button" className="paper-btn" onClick={openDesk}>Check your FPL team</button>
    </div>
  </main>;
}

