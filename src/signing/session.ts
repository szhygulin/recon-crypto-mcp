import {
  getConnectedAccounts,
  getCurrentSession,
  getSignClient,
  isPeerUnreachable,
} from "./walletconnect.js";

export interface SessionStatus {
  paired: boolean;
  accounts: `0x${string}`[];
  topic?: string;
  expiresAt?: number;
  wallet?: string;
  /**
   * Set when a local session record exists but the peer did not respond to the
   * liveness ping on restore. The session may still be valid (peer just
   * offline) or dead (relay didn't deliver a rejection in time) — callers
   * should treat it as unverified and avoid submitting transactions until the
   * peer comes back online or the user re-pairs.
   */
  peerUnreachable?: boolean;
}

export async function getSessionStatus(): Promise<SessionStatus> {
  await getSignClient(); // triggers restore + liveness check
  const session = getCurrentSession();
  if (!session) return { paired: false, accounts: [] };
  const accounts = await getConnectedAccounts();
  const peer = session.peer?.metadata?.name;
  const unreachable = isPeerUnreachable();
  return {
    paired: true,
    accounts,
    topic: session.topic,
    expiresAt: session.expiry * 1000,
    wallet: peer,
    ...(unreachable ? { peerUnreachable: true } : {}),
  };
}
