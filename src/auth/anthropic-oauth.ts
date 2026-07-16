import { TokenStore } from "./store.js";

const AUTH_BASE = "https://auth.anthropic.com";

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type: string;
}

async function post(path: string, body: Record<string, string>): Promise<Response> {
  return fetch(`${AUTH_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

export interface DeviceFlowSession {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
}

export class AnthropicOAuthClient {
  constructor(
    private readonly clientId: string,
    private readonly store: TokenStore
  ) {}

  async getValidToken(): Promise<string | null> {
    const entry = await this.store.read("anthropic");
    if (!entry) return null;
    if (entry.expiresAt && Date.now() >= entry.expiresAt) {
      if (entry.refreshToken) return this.refresh(entry.refreshToken);
      return null;
    }
    return entry.accessToken;
  }

  async startDeviceFlow(): Promise<DeviceFlowSession> {
    const res = await post("/oauth/device/code", {
      client_id: this.clientId,
      scope: "api"
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OAuth device code request failed (${res.status}): ${text}`);
    }
    const data = (await res.json()) as DeviceCodeResponse;
    return {
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      interval: data.interval || 5
    };
  }

  async pollForToken(deviceCode: string, interval: number, signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw new Error("Login cancelled.");
      await new Promise((r) => setTimeout(r, interval * 1000));
      const res = await post("/oauth/token", {
        client_id: this.clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code"
      });
      if (res.ok) {
        const data = (await res.json()) as TokenResponse;
        await this.store.write("anthropic", {
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined
        });
        return;
      }
      // authorization_pending is normal, keep polling
      if (res.status === 400) {
        const body = (await res.json()) as { error?: string };
        if (body.error === "authorization_pending") continue;
        if (body.error === "slow_down") {
          interval += 5;
          continue;
        }
        throw new Error(`OAuth token request failed: ${body.error ?? (await res.text())}`);
      }
      throw new Error(`OAuth token request failed (${res.status}): ${await res.text()}`);
    }
  }

  async logout(): Promise<void> {
    await this.store.delete("anthropic");
  }

  private async refresh(refreshToken: string): Promise<string> {
    const res = await post("/oauth/token", {
      client_id: this.clientId,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    });
    if (!res.ok) {
      await this.store.delete("anthropic");
      throw new Error(`Token refresh failed (${res.status}), run "oracle login" again.`);
    }
    const data = (await res.json()) as TokenResponse;
    await this.store.write("anthropic", {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined
    });
    return data.access_token;
  }
}
