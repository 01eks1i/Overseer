// overseer.json is written by `npm run setup` / `npm run fund` (public addresses only, gitignored).
// A glob import keeps the app compiling before setup has run.
export interface OverseerConfig {
  mint: string;
  decimals: number;
  agent: string;
  merchant: string;
  merchantTokenAccount: string;
  owner: string;
  rpcUrl: string;
  apiBaseUrl: string;
}

const files = import.meta.glob<{ default: OverseerConfig }>("./overseer.json", { eager: true });

export const config: OverseerConfig | null = files["./overseer.json"]?.default ?? null;
