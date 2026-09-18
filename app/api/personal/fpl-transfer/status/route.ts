import { getCurrentUser } from "../../../../lib/auth";
import { evaluatePersonalTransferGate, loadPersonalRefreshToken } from "../../../../lib/personal-fpl-transfer";
import { readRuntimeEnv } from "../../../../lib/runtime-env";

export async function GET() {
  const env = await readRuntimeEnv();
  const user = await getCurrentUser();
  const gate = evaluatePersonalTransferGate(env, user?.email ?? null);
  if (!gate.ok) {
    return Response.json({ enabled: false, reason: gate.reason });
  }
  const token = await loadPersonalRefreshToken(env);
  if (!token) {
    return Response.json({ enabled: false, reason: "missing-refresh-token" });
  }
  // Never return credentials. Only whether the personal path is live for this session.
  return Response.json({ enabled: true, entryId: gate.entryId });
}
