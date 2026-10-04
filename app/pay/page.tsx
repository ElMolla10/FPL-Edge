"use client";

import "../components/PaperStyles";
import { useEffect, useState } from "react";
import { SeasonUpgrade } from "../components/SeasonPass";
import { PaperHeader } from "../components/PaperHeader";
import { track } from "../lib/track";
import { isExampleSquadActive } from "../lib/example-squad";

export default function PayPage() {
  const [checkoutReturn, setCheckoutReturn] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setCheckoutReturn(params.get("checkout") === "return");
    track("pay_view", { ref: params.get("checkout") === "return" ? "checkout-return" : "direct", source: isExampleSquadActive() ? "demo" : "real" });
  }, []);

  return <main className="paper paper-form-page">
    <PaperHeader action={{ href: "/", label: "Back to site" }} />
    <div className="paper-wrap paper-form-wrap">
      <SeasonUpgrade checkoutReturn={checkoutReturn} onDismiss={() => { window.location.assign("/"); }} />
    </div>
  </main>;
}
