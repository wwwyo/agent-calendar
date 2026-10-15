import { GoogleAuth, OAuth2Client, type AuthClient } from "google-auth-library";

export const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/cloud-platform",
];

// Cloud Run では付けた service account（metadata server）で、ローカルでは借りた access token で認証する。鍵は持たない
export async function createAuthClient(accessToken?: string): Promise<AuthClient> {
  if (accessToken) {
    const client = new OAuth2Client();
    client.setCredentials({ access_token: accessToken });
    return client;
  }
  return new GoogleAuth({ scopes: SCOPES }).getClient();
}

export async function bearer(client: AuthClient): Promise<string> {
  const { token } = await client.getAccessToken();
  if (!token) throw new Error("access token を取得できない");
  return token;
}
