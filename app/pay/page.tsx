"use client";

import { useEffect, useState } from "react";
import { SeasonUpgrade } from "../components/SeasonPass";

export default function PayPage() {
  const [checkoutReturn, setCheckoutReturn] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setCheckoutReturn(params.get("checkout") === "return");
  }, []);

  return <main className="marketing-page pay-page">
    <header className="site-header">
      <a className="brand" href="/" aria-label="FPL Edge home"><span className="brand-mark">E</span><span>FPL EDGE</span></a>
      <a className="text-link" href="/">Back to site</a>
    </header>
    <section className="section pay-section">
      <SeasonUpgrade checkoutReturn={checkoutReturn} onDismiss={() => { window.location.assign("/"); }} />
    </section>
  </main>;
}
