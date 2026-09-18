"use client";

import { useEffect, useState } from "react";

type Status = { enabled: boolean; reason?: string; entryId?: string };

// Personal-only. Renders nothing unless the server says this signed-in account
// is allowlisted and the kill switch is on. Never asks for an FPL password.

export default function PersonalTransferPlace({
  elementOut,
  elementIn,
  event,
  purchasePrice,
  outName,
  inName,
}: {
  elementOut: number;
  elementIn: number;
  event: number;
  purchasePrice: number;
  outName: string;
  inName: string;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancel = false;
    fetch("/api/personal/fpl-transfer/status", { cache: "no-store" })
      .then((response) => response.json())
      .then((json: Status) => {
        if (!cancel) setStatus(json);
      })
      .catch(() => {
        if (!cancel) setStatus({ enabled: false, reason: "unavailable" });
      });
    return () => {
      cancel = true;
    };
  }, []);

  if (!status?.enabled) return null;

  const purchasePriceTenths = Math.round(purchasePrice * 10);
  const run = async (confirmed: boolean) => {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/personal/fpl-transfer/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          elementOut,
          elementIn,
          event,
          purchasePriceTenths,
          confirmed,
        }),
      });
      const json = await response.json();
      if (!response.ok || json.ok === false) {
        setMessage(typeof json.error === "string" ? json.error : `FPL returned ${json.status ?? response.status}.`);
        return;
      }
      setMessage(
        confirmed
          ? `Placed on your FPL team: ${outName} → ${inName}.`
          : `Preview ok for ${outName} → ${inName}. Press Place to submit.`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not reach the personal transfer path.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="personal-transfer-place" data-personal-transfer="1">
      <span>PERSONAL FPL</span>
      <p>
        Place <b>{outName}</b> → <b>{inName}</b> on your allowlisted FPL team. Uses your stored FPL session token — Edge still never asks for your FPL password.
      </p>
      <div>
        <button type="button" disabled={busy} onClick={() => run(false)}>
          Preview on FPL
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            if (!window.confirm(`Submit ${outName} → ${inName} on FPL now?`)) return;
            void run(true);
          }}
        >
          Place on my FPL team
        </button>
      </div>
      {message ? <small>{message}</small> : null}
    </div>
  );
}
