import { isMissingTableError } from "../../../../db";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { getUserBySessionToken, readSessionCookie, resolveChatGptUser } from "../../../lib/auth";
import { seasonPassSummaryForUser, type SeasonPassSummary } from "../../../lib/season-access";

const noPass: SeasonPassSummary = { active: false, endsAt: null, seasonKey: null };

async function seasonFor(userId: string): Promise<SeasonPassSummary> {
  try {
    return await seasonPassSummaryForUser(userId);
  } catch (error) {
    // A missing season_passes table must not make a signed-in user look logged out.
    if (isMissingTableError(error)) return noPass;
    throw error;
  }
}

export async function GET() {
  try {
    const token = await readSessionCookie();
    if (token) {
      const user = await getUserBySessionToken(token);
      if (user) return Response.json({ user: { email: user.email, method: "password", seasonPass: await seasonFor(user.id) } });
    }
    const chatgptUser = await getChatGPTUser();
    if (chatgptUser) {
      const user = await resolveChatGptUser(chatgptUser.email);
      return Response.json({ user: { email: user.email, method: "chatgpt", seasonPass: await seasonFor(user.id) } });
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
