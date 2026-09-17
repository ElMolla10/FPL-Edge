import { isMissingTableError } from "../../../../db";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { getUserBySessionToken, readSessionCookie, resolveChatGptUser } from "../../../lib/auth";
import type { UserRecord } from "../../../lib/auth-core";
import { hasProAccess } from "../../../lib/billing/entitlement";

function toMeResponse(user: UserRecord, method: "password" | "chatgpt") {
  return { email: user.email, method, isPro: hasProAccess(user) };
}

export async function GET() {
  try {
    const token = await readSessionCookie();
    if (token) {
      const user = await getUserBySessionToken(token);
      if (user) return Response.json({ user: toMeResponse(user, "password") });
    }
    const chatgptUser = await getChatGPTUser();
    if (chatgptUser) {
      const user = await resolveChatGptUser(chatgptUser.email);
      return Response.json({ user: toMeResponse(user, "chatgpt") });
    }
    return Response.json({ user: null });
  } catch (error) {
    console.error("me error:", error);
    if (isMissingTableError(error)) {
      return Response.json({ user: null, error: "The database schema isn't set up yet. Apply the migration (see README.md) and try again." });
    }
    return Response.json({ user: null });
  }
}
