"use client";

import "../globals.css";
import "../styles/paper.css";
import { useEffect, useState } from "react";
import { SeasonUpgrade } from "../components/SeasonPass";
import { Wordmark } from "../components/Wordmark";

export default function PayPage() {
  const [checkoutReturn, setCheckoutReturn] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setCheckoutReturn(params.get("checkout") === "return");
  }, []);

  return <main className="paper paper-form-page">
    <header className="paper-header">
      <div className="paper-wrap paper-header-inner">
        <a className="paper-wordmark" href="/" aria-label="FPL Edge home"><Wordmark/></a>
        <a className="paper-signin" href="/">Back to site</a>
      </div>
    </header>
    <div className="paper-wrap paper-form-wrap">
      <SeasonUpgrade checkoutReturn={checkoutReturn} onDismiss={() => { window.location.assign("/"); }} />
    </div>
  </main>;
}
