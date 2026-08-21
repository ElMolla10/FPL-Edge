import { getChatGPTUser } from "../../../chatgpt-auth";
import { getUserBySessionToken, readSessionCookie, resolveChatGptUser } from "../../../lib/auth";

export async function GET() {
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
}
