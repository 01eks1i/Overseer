// One-time devnet setup: keypairs, a test USDC mint, token accounts and SOL for fees.
// Safe to re-run: it only creates what is missing.
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, type Keypair } from "@solana/web3.js";
import { createMint, getMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { readState, writeState } from "../lib/config.js";
import { connection, explorerAddress, loadKeypair, toBaseUnits } from "../lib/solana.js";

const DECIMALS = 6;
// Setup itself needs ~0.08 SOL (fees for agent + test owner, mint and token account rent);
// the rest pays for `npm run fund`. Kept low because devnet faucets are tightly rate-limited.
const MIN_ADMIN_SOL = 0.25;

const admin = loadKeypair("admin");
const agent = loadKeypair("agent");
const merchant = loadKeypair("merchant");
const owner = loadKeypair("owner");

console.log("Admin (pays for setup):", admin.publicKey.toBase58());
console.log("Agent (spends the allowance):", agent.publicKey.toBase58());
console.log("Merchant (receives payments):", merchant.publicKey.toBase58());
console.log("Test owner (CLI testing without a browser wallet):", owner.publicKey.toBase58());

// 1. Make sure the admin has devnet SOL.
let adminSol = (await connection.getBalance(admin.publicKey)) / LAMPORTS_PER_SOL;
if (adminSol < MIN_ADMIN_SOL) {
  console.log(`\nAdmin has ${adminSol} SOL. Requesting a devnet airdrop...`);
  try {
    const sig = await connection.requestAirdrop(admin.publicKey, 2 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
    adminSol = (await connection.getBalance(admin.publicKey)) / LAMPORTS_PER_SOL;
  } catch (e) {
    console.error(`\nThe airdrop failed (the devnet faucet is rate-limited): ${(e as Error).message}`);
    console.error(`Send at least ${MIN_ADMIN_SOL} devnet SOL to the admin address:\n\n  ${admin.publicKey.toBase58()}\n`);
    console.error("Where to get it:");
    console.error("  - https://faucet.solana.com (network: devnet). Sign in with GitHub if you hit the 2-requests-per-8-hours limit");
    console.error("  - https://devnetfaucet.org (separate rate limit)");
    console.error("  - or send it from any wallet that already has devnet SOL (e.g. a teammate's)\n");
    console.error("Then run `npm run setup` again.");
    process.exit(1);
  }
}
console.log(`Admin balance: ${adminSol} SOL`);

// 2. SOL for transaction fees.
async function topUp(target: Keypair | PublicKey, minSol: number, label: string) {
  const pubkey = "publicKey" in target ? target.publicKey : target;
  const balance = await connection.getBalance(pubkey);
  const needed = Math.round(minSol * LAMPORTS_PER_SOL) - balance;
  if (needed <= 0) return;
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: pubkey, lamports: needed }));
  await sendAndConfirmTransaction(connection, tx, [admin]);
  console.log(`Sent ${needed / LAMPORTS_PER_SOL} SOL to ${label} for fees`);
}
await topUp(agent, 0.05, "agent"); // ~10,000 payments' worth of fees
await topUp(owner, 0.02, "test owner");

// 3. Test USDC mint. The admin is the mint authority, so we can hand out test dollars freely.
let state = readState();
let mint: PublicKey | undefined = state.mint ? new PublicKey(state.mint) : undefined;
if (mint) {
  try {
    await getMint(connection, mint);
  } catch {
    mint = undefined; // Stale state (e.g. devnet reset or different RPC)
  }
}
if (!mint) {
  mint = await createMint(connection, admin, admin.publicKey, null, DECIMALS);
  console.log("Created test USDC mint:", mint.toBase58());
}

// 4. Token accounts: the merchant receives payments; the test owner gets 100 test USDC.
const merchantAccount = await getOrCreateAssociatedTokenAccount(connection, admin, mint, merchant.publicKey);
const ownerAccount = await getOrCreateAssociatedTokenAccount(connection, admin, mint, owner.publicKey);
if (ownerAccount.amount === 0n) {
  await mintTo(connection, admin, mint, ownerAccount.address, admin, toBaseUnits(100, DECIMALS));
  console.log("Minted 100 test USDC to the test owner");
}

state = writeState({
  mint: mint.toBase58(),
  decimals: DECIMALS,
  admin: admin.publicKey.toBase58(),
  agent: agent.publicKey.toBase58(),
  merchant: merchant.publicKey.toBase58(),
  merchantTokenAccount: merchantAccount.address.toBase58(),
  owner: state.owner ?? owner.publicKey.toBase58(),
});

console.log("\nSetup complete.");
console.log("Mint:", explorerAddress(state.mint!));
console.log("Agent spends from owner:", state.owner);
console.log("\nNext: `npm run fund -- <your Phantom/Solflare devnet address>` to use your own wallet in the dashboard.");
