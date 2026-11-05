import { randomBytes, randomUUID } from 'crypto';

export interface Session {
  id: string;
  token: string;           // high-entropy secret embedded in the QR URL
  createdAt: number;
  expiresAt: number;
  extensionConnected: boolean;
  mobileConnected: boolean;
}

export class SessionManager {
  private session: Session | null = null;
  private readonly timeoutSeconds: number;
  private readonly fixedToken: string | undefined;

  constructor(timeoutSeconds = 3600, fixedToken?: string) {
    this.timeoutSeconds = timeoutSeconds;
    this.fixedToken = fixedToken && fixedToken.trim() ? fixedToken.trim() : undefined;
  }

  create(): Session {
    const now = Date.now();
    this.session = {
      id: randomUUID(),
      token: this.fixedToken ?? this.generateToken(),
      createdAt: now,
      expiresAt: now + this.timeoutSeconds * 1000,
      extensionConnected: false,
      mobileConnected: false,
    };
    return this.session;
  }

  get(): Session | null {
    return this.session;
  }

  isValid(token: string): boolean {
    if (!this.session) return false;
    if (Date.now() > this.session.expiresAt) return false;
    return this.session.token === token;
  }

  isExpired(): boolean {
    if (!this.session) return true;
    return Date.now() > this.session.expiresAt;
  }

  private generateToken(): string {
    return randomBytes(24).toString('base64url');
  }
}
