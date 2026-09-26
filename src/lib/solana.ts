import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Connection, Keypair, PublicKey, TransactionInstruction, type TransactionError } from "@solana/web3.js";
import { KEYS_DIR, RPC_URL } from "./config.js";

export const connection = new Connection(RPC_URL, "confirmed");

export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

// `agent-<project id>` holds the agent key of one ApiSift project.
export type KeyName = "admin" | "agent" | "merchant" | "owner" | `agent-${string}`;

/** Loads keys/<name>.json, generating it on first use. These are devnet-only keys. */
export function loadKeypair(name: KeyName): Keypair {
  const file = join(KEYS_DIR, `${name}.json`);
  if (!existsSync(file)) {
    mkdirSync(KEYS_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(file, "utf8")) as number[]));
}

export function memoInstruction(text: string, signer?: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: signer ? [{ pubkey: signer, isSigner: true, isWritable: false }] : [],
    data: Buffer.from(text, "utf8"),
  });
}

export const explorerTx = (signature: string) => `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
export const explorerAddress = (address: string) => `https://explorer.solana.com/address/${address}?cluster=devnet`;

export function toBaseUnits(amount: string | number, decimals: number): bigint {
  const [whole, frac = ""] = String(amount).split(".");
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

export function fromBaseUnits(amount: bigint, decimals: number): string {
  const s = amount.toString().padStart(decimals + 1, "0");
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${s.slice(0, -decimals)}.${frac}` : s.slice(0, -decimals);
}

/** SPL Token program error codes we expect to hit when the agent overspends. */
const TOKEN_ERRORS: Record<number, string> = {
  1: "InsufficientFunds",
  4: "OwnerMismatch",
};

export function describeTxError(err: TransactionError | null): string {
  if (!err) return "none";
  if (typeof err === "object" && "InstructionError" in err) {
    const [index, detail] = (err as { InstructionError: [number, unknown] }).InstructionError;
    if (detail && typeof detail === "object" && "Custom" in detail) {
      const code = (detail as { Custom: number }).Custom;
      return `instruction ${index} failed: ${TOKEN_ERRORS[code] ?? `custom error ${code}`}`;
    }
    return `instruction ${index} failed: ${JSON.stringify(detail)}`;
  }
  return JSON.stringify(err);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
