import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

try {
  process.loadEnvFile(join(ROOT, ".env"));
} catch {
  // No .env file: fall back to defaults below.
}

export const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
export const API_PORT = Number(process.env.API_PORT ?? 4020);
export const API_BASE_URL = process.env.API_BASE_URL ?? `http://localhost:${API_PORT}`;
export const NETWORK = "solana-devnet";

export const KEYS_DIR = join(ROOT, "keys");
const STATE_FILE = join(ROOT, ".overseer", "state.json");
const WEB_CONFIG_FILE = join(ROOT, "web", "src", "overseer.json");

/** Public addresses produced by `npm run setup` and `npm run fund`. */
export interface State {
  mint?: string;
  decimals?: number;
  admin?: string;
  agent?: string;
  merchant?: string;
  merchantTokenAccount?: string;
  /** Wallet whose token account the agent spends from (via its delegated allowance). */
  owner?: string;
}

export function readState(): State {
  if (!existsSync(STATE_FILE)) return {};
  return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
}

export function writeState(patch: Partial<State>): State {
  const next = { ...readState(), ...patch };
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(next, null, 2) + "\n");
  // The dashboard only ever sees public addresses.
  mkdirSync(dirname(WEB_CONFIG_FILE), { recursive: true });
  writeFileSync(
    WEB_CONFIG_FILE,
    JSON.stringify({ ...next, rpcUrl: RPC_URL, apiBaseUrl: API_BASE_URL }, null, 2) + "\n",
  );
  return next;
}

/** State with the fields every runtime component needs, or a clear error telling you to run setup. */
export function requireState(): Required<Pick<State, "mint" | "decimals" | "agent" | "merchant" | "merchantTokenAccount" | "owner">> & State {
  const s = readState();
  for (const key of ["mint", "decimals", "agent", "merchant", "merchantTokenAccount", "owner"] as const) {
    if (s[key] === undefined) throw new Error(`Missing "${key}" in .overseer/state.json. Run \`npm run setup\` first.`);
  }
  return s as ReturnType<typeof requireState>;
}
