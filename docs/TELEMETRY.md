# First-party telemetry

`POST /api/telemetry` `{event, meta?, path?}` → row in D1 `telemetry_events` (id, ts, event, user_hash, meta JSON, path).
Same-origin only, 60 events/min/IP per isolate (429, never 500), 2 KB body cap. Unknown events are dropped (204).
Meta keeps only `source, action, gw, view, mode, plan, result, ref`; email-like values are dropped. `user_hash` = salted SHA-256 of the user id.
Funnel events (`app_open, team_connected, call_viewed, lock_created, pay_view`) always carry `meta.source` = `real | demo | unknown`.
`pass_activated` is written server-side when Paymob confirms.

Apply: `npx wrangler d1 migrations apply fpl-edge-db --remote` (CI does this on deploy).

## Funnel (last 7 days, distinct visitors where known)

```sql
SELECT event, COUNT(*) AS events, COUNT(DISTINCT user_hash) AS users
FROM telemetry_events
WHERE ts >= datetime('now','-7 days')
  AND event IN ('landing_view','demo_open','signin_success','pay_view','pass_activated')
  AND COALESCE(json_extract(meta,'$.source'),'real') <> 'demo'
GROUP BY event
ORDER BY CASE event WHEN 'landing_view' THEN 1 WHEN 'demo_open' THEN 2 WHEN 'signin_success' THEN 3 WHEN 'pay_view' THEN 4 ELSE 5 END;
```

```sh
npx wrangler d1 execute fpl-edge-db --remote --command "SELECT event, COUNT(*) FROM telemetry_events GROUP BY event"
```
