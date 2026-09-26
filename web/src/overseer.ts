// Reads the owner's token account and its transaction history from devnet, and turns it into
// the allowance status and activity feed shown on the dashboard.
import { useCallback, useEffect, useRef, useState } from "react";
import { Buffer } from "buffer";
import {
  PublicKey,
  TransactionInstruction,
  type Connection,
  type ParsedInstruction,
  type ParsedTransactionWithMeta,
  type PartiallyDecodedInstruction,
} from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { OverseerConfig } from "./config";

const POLL_MS = 3000;
const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

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

export function memoInstruction(text: string): TransactionInstruction {
  return new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(text, "utf8") });
}

export type ActivityKind = "paid" | "blocked" | "refunded" | "allowance" | "revoked" | "funded" | "failed";

export interface Activity {
  signature: string;
  time: number | null;
  kind: ActivityKind;
  title: string;
  detail?: string;
  /** Amount in USDC for payments, allowances and top-ups. */
  amount?: string;
}

const isParsed = (ix: ParsedInstruction | PartiallyDecodedInstruction): ix is ParsedInstruction => "parsed" in ix;

export function parseActivity(signature: string, tx: ParsedTransactionWithMeta, ownerTokenAccount: string, cfg: OverseerConfig): Activity | null {
  const instructions = tx.transaction.message.instructions.filter(isParsed);
  const memo = instructions.find((ix) => ix.program === "spl-memo")?.parsed as string | undefined;
  const failed = !!tx.meta?.err;
  const base = { signature, time: tx.blockTime ?? null };
  const uiAmount = (info: Record<string, any>) =>
    info.tokenAmount?.uiAmountString ?? (info.amount !== undefined ? fromBaseUnits(BigInt(info.amount), cfg.decimals) : undefined);

  for (const ix of instructions) {
    if (ix.program !== "spl-token") continue;
    const { type, info } = ix.parsed as { type: string; info: Record<string, any> };
    const amount = uiAmount(info);

    // The paid API sends the money back when a service fails after charging (memo "overseer:refund <payment>").
    if ((type === "transferChecked" || type === "transfer") && info.destination === ownerTokenAccount && !failed) {
      const refundOf = memo?.match(/^overseer:refund (\S+)/)?.[1];
      return {
        ...base,
        kind: "refunded",
        title: refundOf ? `Refunded ${amount} USDC` : `Received ${amount} USDC`,
        detail: refundOf ? "The service failed after payment, so the money was sent back" : undefined,
        amount,
      };
    }

    if ((type === "transferChecked" || type === "transfer") && info.source === ownerTokenAccount) {
      // Memo format from the paid API: "overseer:<challenge> <service description>"
      const detail = memo?.replace(/^overseer:\S+\s*/, "") || undefined;
      const byAgent = (info.authority ?? info.multisigAuthority) === cfg.agent;
      if (failed) return { ...base, kind: "blocked", title: `Blocked by Solana: ${amount} USDC`, detail, amount };
      return { ...base, kind: "paid", title: `${byAgent ? "Agent paid" : "Sent"} ${amount} USDC`, detail, amount };
    }
    if (type === "approveChecked" || type === "approve") {
      if (failed) return { ...base, kind: "failed", title: "Setting the allowance failed" };
      const toAgent = info.delegate === cfg.agent;
      return { ...base, kind: "allowance", title: `Allowance set to ${amount} USDC`, detail: toAgent ? undefined : `Delegate ${shorten(info.delegate)} is not the agent`, amount };
    }
    if (type === "revoke") {
      return failed ? { ...base, kind: "failed", title: "Revoke failed" } : { ...base, kind: "revoked", title: "Allowance revoked" };
    }
    if ((type === "mintTo" || type === "mintToChecked") && !failed) {
      return { ...base, kind: "funded", title: `Received ${amount} test USDC`, amount };
    }
  }
  return null;
}

export interface TokenAccountState {
  balance: bigint;
  delegate: string | null;
  delegatedAmount: bigint;
}

export interface OverseerData {
  ownerTokenAccount: string;
  /** undefined while loading, null if the owner has no token account yet. */
  account: TokenAccountState | null | undefined;
  activity: Activity[];
  agentSol: number | null;
  error: string | null;
  refresh: () => void;
}

export function useOverseerData(connection: Connection, cfg: OverseerConfig): OverseerData {
  const ownerTokenAccount = getAssociatedTokenAddressSync(new PublicKey(cfg.mint), new PublicKey(cfg.owner)).toBase58();
  const [account, setAccount] = useState<TokenAccountState | null | undefined>(undefined);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [agentSol, setAgentSol] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const parsed = useRef(new Map<string, Activity | null>());
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const tokenAccount = new PublicKey(ownerTokenAccount);
      const [acc, sigs, lamports] = await Promise.all([
        getAccount(connection, tokenAccount).catch(() => null),
        connection.getSignaturesForAddress(tokenAccount, { limit: 30 }),
        connection.getBalance(new PublicKey(cfg.agent)),
      ]);
      setAccount(
        acc && { balance: acc.amount, delegate: acc.delegate?.toBase58() ?? null, delegatedAmount: acc.delegatedAmount },
      );
      setAgentSol(lamports / 1e9);

      const unseen = sigs.map((s) => s.signature).filter((s) => !parsed.current.has(s));
      if (unseen.length) {
        const txs = await connection.getParsedTransactions(unseen, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
        // Batched RPC responses can come back out of order, so key each result by its own signature.
        // Transactions not found yet stay unseen and are retried on the next poll.
        for (const tx of txs) {
          if (!tx) continue;
          const signature = tx.transaction.signatures[0];
          parsed.current.set(signature, parseActivity(signature, tx, ownerTokenAccount, cfg));
        }
      }
      setActivity(sigs.map((s) => parsed.current.get(s.signature)).filter((a): a is Activity => !!a));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      inFlight.current = false;
    }
  }, [connection, cfg, ownerTokenAccount]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  return { ownerTokenAccount, account, activity, agentSol, error, refresh: () => void refresh() };
}

export interface ServiceListing {
  id: string;
  method: string;
  url: string;
  priceUsdc: string;
  description: string;
}

/** Paid services from the Overseer API; null while the API is unreachable. */
export function useServices(apiBaseUrl: string): ServiceListing[] | null {
  const [services, setServices] = useState<ServiceListing[] | null>(null);
  useEffect(() => {
    const load = () =>
      fetch(`${apiBaseUrl}/api/services`)
        .then((r) => r.json())
        .then((d: { services: ServiceListing[] }) => setServices(d.services))
        .catch(() => setServices(null));
    void load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [apiBaseUrl]);
  return services;
}
