"use client";

import "./components/PaperStyles";
import "./styles/landing.css";
import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { Wordmark } from "./components/Wordmark";
import { LegalLinks } from "./components/LegalLinks";
import { formatSeasonPassPrice } from "./lib/season-pass";
import { fetchFplData } from "./lib/fpl";
import type { FplData } from "./lib/fpl";
import { exampleDeskSummary } from "./lib/example-squad";
import { track } from "./lib/track";

// Lazy: CoachApp pulls in the entire connected-app tree (LiveDraftBuilder, LiveIntelligence, the
// optimizer). A static import here bundled all of that into this marketing page's own chunk, so
// every visitor downloaded it even if appMode never becomes true. Loaded only once someone
// actually enters the app.
const CoachApp = lazy(() => import("./components/CoachApp"));

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
  const [startExample, setStartExample] = useState(false);
  const [data, setData] = useState<FplData | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("checkout") === "return") window.location.replace("/pay?checkout=return");
    if (params.get("demo") === "1") { setStartExample(true); setAppMode("demo"); track("demo_open", { ref: "url" }); }
    else if (params.get("app") === "1") { setAppMode("demo"); track("app_open", { ref: "url" }); }
    else track("landing_view", {}, { onceKey: "session" });
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
    try { return exampleDeskSummary(data); } catch { return null; }
  }, [data]);
  if (appMode) return <Suspense fallback={<div className="coach-loading"><b>Opening the desk…</b></div>}><CoachApp onBack={() => { setAppMode(null); setStartExample(false); }} startAuth={appMode === "signin"} startExample={startExample} /></Suspense>;

  const clock = desk ? countdown(desk.deadline, now) : "";
  const openDesk = () => { track("app_open", { ref: "landing" }); setStartExample(false); setAppMode("demo"); };
  const openDemo = () => { track("demo_open", { ref: "landing" }); setStartExample(true); setAppMode("demo"); };
  const points = (value: number | null) => value === null ? "—" : value.toFixed(1);

  return <main className="paper">
    <header className={scrolled ? "paper-header is-scrolled" : "paper-header"}>
      <div className="paper-wrap paper-header-inner">
        <a className="paper-wordmark" href="/" aria-label="FPL Edge home"><Wordmark/></a>
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
            <button type="button" className="paper-btn paper-demo" onClick={openDemo}>Open Demo</button>
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
          <div className="paper-compare" aria-label="Roll or move">
            <div className="paper-option is-pick">
              <span className="paper-label">Roll</span>
              <b>{points(desk?.total ?? null)}</b>
              <small>Recommended</small>
            </div>
            <div className="paper-option">
              <span className="paper-label">Move</span>
              <b>—</b>
              <small>Connect a team to compare</small>
            </div>
          </div>
          <div className="paper-captain">
            <div className="paper-captain-name">
              <b>{desk?.captain?.name ?? "—"}</b>
              <span className="paper-c" aria-label="Captain">C</span>
            </div>
            <span>{desk?.captain ? `${desk.captain.teamShort} · ${points(desk.captainPoints)} projected` : "Until a team is connected"}</span>
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
        <span className="paper-wordmark"><Wordmark/></span>
        <p>Independent. Not affiliated with the Premier League.</p>
        <LegalLinks />
      </footer>
    </div>
    <div className="paper-dock">
      <p className="paper-dock-trust">Official FPL data · No password needed</p>
      <button type="button" className="paper-btn" onClick={openDesk}>Check my team</button>
      <button type="button" className="paper-btn paper-demo" onClick={openDemo}>Open Demo</button>
    </div>
  </main>;
}

