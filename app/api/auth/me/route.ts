import { isMissingTableError } from "../../../../db";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { getUserBySessionToken, readSessionCookie, resolveChatGptUser } from "../../../lib/auth";

export async function GET() {
  try {
    const token = await readSessionCookie();
    if (token) {
      const user = await getUserBySessionToken(token);
      if (user) return Response.json({ user: { email: user.email, method: "password" } });
    }
    const chatgptUser = await getChatGPTUser();
    if (chatgptUser) {
      const user = await resolveChatGptUser(chatgptUser.email);
      return Response.json({ user: { email: user.email, method: "chatgpt" } });
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
