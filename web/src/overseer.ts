// Small helpers for the web app. All Solana reads happen on the ApiSift API server (cached and shared
// by every tab), so the browser never calls the Solana RPC itself.
import { useCallback, useState } from "react";
import { api, useVisiblePolling, type Activity } from "./api";

export type { Activity, ActivityKind } from "./api";

export const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
export const explorerAddress = (addr: string) => `https://explorer.solana.com/address/${addr}?cluster=devnet`;
export const shorten = (addr: string) => `${addr.slice(0, 4)}…${addr.slice(-4)}`;

export function toBaseUnits(amount: string, decimals: number): bigint {
  const [whole, frac = ""] = amount.trim().split(".");
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

export function fromBaseUnits(amount: bigint, decimals: number): string {
  const s = amount.toString().padStart(decimals + 1, "0");
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${s.slice(0, -decimals)}.${frac}` : s.slice(0, -decimals);
}

/** A project's activity feed, parsed and cached on the API server. */
export function useActivity(projectId: string) {
  const [activity, setActivity] = useState<Activity[]>([]);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    api.activity(projectId).then(
      (feed) => {
        setActivity(feed.activity);
        setError(feed.stale ? `${feed.stale}. Showing activity from ${new Date(feed.updatedAt).toLocaleTimeString()}; retrying.` : null);
      },
      (e: Error) => setError(e.message),
    );
  }, [projectId]);
  useVisiblePolling(refresh, 4000);
  return { activity, error, refresh };
}
