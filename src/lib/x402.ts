// Message shapes for our x402-style flow (https://solana.com/x402):
// 1. Client requests a resource, server answers 402 with a PaymentRequired body.
// 2. Client pays on Solana, putting the offer's memo (which contains a one-time challenge) in the transaction.
// 3. Client retries with an X-PAYMENT header; server verifies the transaction on-chain and serves the resource.
// Unlike the official x402 "exact" scheme, the client submits the transaction itself, because it pays
// as a delegate of someone else's token account.

export interface PaymentOffer {
  scheme: "exact";
  network: "solana-devnet";
  /** Price in base units of `asset`. */
  maxAmountRequired: string;
  /** Token mint. */
  asset: string;
  /** Wallet that gets paid. */
  payTo: string;
  resource: string;
  description: string;
  mimeType: string;
  maxTimeoutSeconds: number;
  extra: { challenge: string; decimals: number; payToTokenAccount: string; memo: string };
}

export interface PaymentRequired {
  x402Version: 1;
  error: string;
  accepts: PaymentOffer[];
}

export interface PaymentPayload {
  x402Version: 1;
  scheme: "exact";
  network: "solana-devnet";
  payload: { signature: string; challenge: string };
}

export interface PaymentResponse {
  success: boolean;
  transaction: string;
  network: "solana-devnet";
  payer: string;
}

export const encodeHeader = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
export const decodeHeader = <T>(header: string): T => JSON.parse(Buffer.from(header, "base64").toString("utf8")) as T;
