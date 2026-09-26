// ApiSift "office": projects, their allowances, and repo analysis, driven by the demo wallet.
// These routes sign with the demo wallet's key (keys/owner.json), so they only answer requests from this machine.
import { Router, type ErrorRequestHandler, type Request } from "express";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  type ParsedAccountData,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  ACCOUNT_SIZE,
  TOKEN_PROGRAM_ID,
  createApproveCheckedInstruction,
  createInitializeAccount3Instruction,
  createRevokeInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMinimumBalanceForRentExemptAccount,
} from "@solana/spl-token";
import { requireState } from "../lib/config.js";
import { activityFromSignature, parseActivity, type Activity } from "../lib/activity.js";
import { findProject, listProjects, newProjectId, saveProject, type Project } from "../lib/projects.js";
import { connection, describeTxError, explorerTx, fromBaseUnits, loadKeypair, memoInstruction, sendAndConfirm, toBaseUnits } from "../lib/solana.js";
import { parseRepoUrl, readGithubRepo, UserError } from "./github.js";
import { analyzerConfigured, runAnalysis } from "./services.js";

export const office = Router();

const LOCAL_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
office.use((req, res, next) => {
  if (LOCAL_ADDRESSES.has(req.socket.remoteAddress ?? "")) return next();
  res.status(403).json({ error: "The ApiSift office signs with the demo wallet, so it only answers requests from this machine." });
});

/** The admin pays fees and rent, so the demo wallet only ever needs USDC. */
async function send(instructions: TransactionInstruction[], signers: Keypair[]): Promise<string> {
  const admin = loadKeypair("admin");
  const tx = new Transaction().add(...instructions);
  tx.feePayer = admin.publicKey;
  const { signature, err } = await sendAndConfirm(tx, [admin, ...signers]);
  // Balances and feeds changed: refresh them on the next request.
  officeCache.expire();
  for (const feed of feeds.values()) feed.expire();
  if (err) throw new Error(`The transaction failed on-chain: ${describeTxError(err)}`);
  return signature;
}

/**
 * Devnet reads are cached and shared by every browser tab, so the web app never talks to Solana itself.
 * When the RPC refuses (the public endpoint rate-limits per IP), it backs off and keeps serving the last
 * good value, marked stale, instead of an error.
 */
class DevnetCache<T> {
  private value: T | undefined;
  private updatedAt = 0;
  private nextRefreshAt = 0;
  private pending: Promise<void> | undefined;
  private error: string | null = null;

  constructor(
    private readonly load: () => Promise<T>,
    private readonly ttlMs: number,
    private readonly backoffMs = 10_000,
  ) {}

  expire() {
    this.nextRefreshAt = 0;
  }

  async get(): Promise<{ value: T; updatedAt: number; stale: string | null }> {
    if (Date.now() >= this.nextRefreshAt) {
      this.pending ??= this.load()
        .then((value) => {
          this.value = value;
          this.updatedAt = Date.now();
          this.error = null;
          this.nextRefreshAt = Date.now() + this.ttlMs;
        })
        .catch((error: Error) => {
          this.error = error.message.includes("429") ? "Solana devnet is rate-limiting this network" : error.message;
          this.nextRefreshAt = Date.now() + this.backoffMs;
        })
        .finally(() => {
          this.pending = undefined;
        });
      await this.pending;
    }
    if (this.value === undefined) throw new Error(this.error ?? "No data from Solana yet");
    return { value: this.value, updatedAt: this.updatedAt, stale: this.error };
  }
}

function requireProject(req: Request): Project {
  const project = findProject(String(req.params.id));
  if (!project) throw new UserError(`No project called "${req.params.id}"`);
  return project;
}

async function loadOffice() {
  const state = requireState();
  const owner = loadKeypair("owner").publicKey;
  const wallet = getAssociatedTokenAddressSync(new PublicKey(state.mint), owner);
  const projects = listProjects().filter((p) => p.owner === owner.toBase58());

  // One RPC call for the wallet, every budget account and every agent.
  const keys = [wallet, ...projects.flatMap((p) => [new PublicKey(p.tokenAccount), new PublicKey(p.agent)])];
  const { value } = await connection.getMultipleParsedAccounts(keys);
  const tokenInfo = (i: number) => {
    const data = value[i]?.data;
    return data && "parsed" in data
      ? ((data as ParsedAccountData).parsed.info as {
          tokenAmount: { uiAmountString: string };
          delegate?: string;
          delegatedAmount?: { uiAmountString: string };
        })
      : null;
  };

  return {
    wallet: { address: owner.toBase58(), tokenAccount: wallet.toBase58(), balanceUsdc: tokenInfo(0)?.tokenAmount.uiAmountString ?? "0" },
    mint: state.mint,
    decimals: state.decimals,
    projects: projects.map((project, i) => {
      const budget = tokenInfo(1 + 2 * i);
      const delegated = budget?.delegate === project.agent;
      return {
        ...project,
        budgetUsdc: budget?.tokenAmount.uiAmountString ?? "0",
        allowanceUsdc: delegated ? (budget?.delegatedAmount?.uiAmountString ?? "0") : "0",
        delegated,
        agentSol: (value[2 + 2 * i]?.lamports ?? 0) / LAMPORTS_PER_SOL,
      };
    }),
  };
}

const officeCache = new DevnetCache(loadOffice, 3_000);

office.get("/", async (_req, res) => {
  const { value, updatedAt, stale } = await officeCache.get();
  res.json({ ...value, updatedAt, stale });
});

// Activity feed of one project's budget account, parsed on the server and cached per project.
const FEED_CHUNK = 5;
const feeds = new Map<string, DevnetCache<Activity[]>>();

function feedFor(project: Project): DevnetCache<Activity[]> {
  let feed = feeds.get(project.id);
  if (!feed) {
    const parsed = new Map<string, Activity | null>();
    const decimals = requireState().decimals;
    feed = new DevnetCache(async () => {
      const sigs = await connection.getSignaturesForAddress(new PublicKey(project.tokenAccount), { limit: 25 });
      const unseen = sigs.map((s) => s.signature).filter((s) => !parsed.has(s));
      // Fetch in small chunks: the public RPC also limits each method per IP, and a 30-transaction batch
      // trips it. Parsed transactions are kept, so after a refusal the next refresh continues where it stopped.
      for (let i = 0; i < unseen.length; i += FEED_CHUNK) {
        let txs;
        try {
          txs = await connection.getParsedTransactions(unseen.slice(i, i + FEED_CHUNK), {
            maxSupportedTransactionVersion: 0,
            commitment: "confirmed",
          });
        } catch {
          break; // show what we have; the rest arrives on later refreshes
        }
        // Batched RPC responses can come back out of order, so key each result by its own signature.
        // Transactions not found yet stay unseen and are retried on the next refresh.
        for (const tx of txs) {
          if (tx) parsed.set(tx.transaction.signatures[0], parseActivity(tx.transaction.signatures[0], tx, project.tokenAccount, project.agent, decimals));
        }
      }
      // Detailed parse where we have it, otherwise the row built from the signature list's memo.
      return sigs.map((s) => parsed.get(s.signature) ?? activityFromSignature(s)).filter((a): a is Activity => !!a);
    }, 3_000);
    feeds.set(project.id, feed);
  }
  return feed;
}

office.get("/projects/:id/activity", async (req, res) => {
  const feed = feedFor(requireProject(req));
  try {
    const { value, updatedAt, stale } = await feed.get();
    res.json({ activity: value, updatedAt, stale });
  } catch (error) {
    // Nothing loaded yet (Solana refused the very first read): an empty feed that says why, not an error.
    res.json({ activity: [], updatedAt: 0, stale: (error as Error).message });
  }
});

office.post("/projects", async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  const repoUrl = String(req.body?.repoUrl ?? "").trim() || undefined;
  if (!name || name.length > 40) throw new UserError("Give the project a name of up to 40 characters.");
  if (repoUrl) parseRepoUrl(repoUrl);

  const state = requireState();
  const admin = loadKeypair("admin");
  const owner = loadKeypair("owner").publicKey;
  const id = newProjectId(name);
  const agent = loadKeypair(`agent-${id}`);
  const budget = Keypair.generate();
  const rent = await getMinimumBalanceForRentExemptAccount(connection);

  // One transaction: the budget account (owned by the demo wallet) plus SOL for the agent's own payment fees.
  const signature = await send(
    [
      SystemProgram.createAccount({
        fromPubkey: admin.publicKey,
        newAccountPubkey: budget.publicKey,
        lamports: rent,
        space: ACCOUNT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeAccount3Instruction(budget.publicKey, new PublicKey(state.mint), owner),
      SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: agent.publicKey, lamports: 0.01 * LAMPORTS_PER_SOL }),
      memoInstruction(`overseer: project "${name}" created`),
    ],
    [budget],
  );

  const project: Project = {
    id,
    name,
    repoUrl,
    owner: owner.toBase58(),
    agent: agent.publicKey.toBase58(),
    tokenAccount: budget.publicKey.toBase58(),
    createdAt: new Date().toISOString(),
  };
  saveProject(project);
  res.status(201).json({ project, explorer: explorerTx(signature) });
});

// Sets the agent's allowance to `amountUsdc`, topping the project budget up from the wallet if needed.
office.post("/projects/:id/allowance", async (req, res) => {
  const project = requireProject(req);
  const amount = String(req.body?.amountUsdc ?? "").trim();
  const state = requireState();
  if (!/^\d+(\.\d{1,6})?$/.test(amount) || toBaseUnits(amount, state.decimals) <= 0n) {
    throw new UserError("Enter an allowance above 0, like 0.50.");
  }
  const units = toBaseUnits(amount, state.decimals);
  const owner = loadKeypair("owner");
  const mint = new PublicKey(state.mint);
  const wallet = getAssociatedTokenAddressSync(mint, owner.publicKey);
  const budget = new PublicKey(project.tokenAccount);
  const [walletAccount, budgetAccount] = await Promise.all([getAccount(connection, wallet), getAccount(connection, budget)]);

  const topUp = units > budgetAccount.amount ? units - budgetAccount.amount : 0n;
  if (topUp > walletAccount.amount) {
    throw new UserError(`The demo wallet only has ${fromBaseUnits(walletAccount.amount, state.decimals)} USDC.`);
  }
  const instructions: TransactionInstruction[] = [];
  if (topUp > 0n) instructions.push(createTransferCheckedInstruction(wallet, mint, budget, owner.publicKey, topUp, state.decimals));
  instructions.push(
    createApproveCheckedInstruction(budget, mint, new PublicKey(project.agent), owner.publicKey, units, state.decimals),
    memoInstruction(`overseer: allowance set to ${fromBaseUnits(units, state.decimals)} USDC`),
  );
  const signature = await send(instructions, [owner]);
  res.json({
    allowanceUsdc: fromBaseUnits(units, state.decimals),
    toppedUpUsdc: fromBaseUnits(topUp, state.decimals),
    explorer: explorerTx(signature),
  });
});

// Revokes the agent's allowance and moves the unused budget back to the wallet.
office.post("/projects/:id/revoke", async (req, res) => {
  const project = requireProject(req);
  const state = requireState();
  const owner = loadKeypair("owner");
  const mint = new PublicKey(state.mint);
  const budget = new PublicKey(project.tokenAccount);
  const wallet = getAssociatedTokenAddressSync(mint, owner.publicKey);
  const budgetAccount = await getAccount(connection, budget);

  const instructions: TransactionInstruction[] = [createRevokeInstruction(budget, owner.publicKey)];
  if (budgetAccount.amount > 0n) {
    instructions.push(createTransferCheckedInstruction(budget, mint, wallet, owner.publicKey, budgetAccount.amount, state.decimals));
  }
  instructions.push(memoInstruction("overseer: allowance revoked"));
  const signature = await send(instructions, [owner]);
  res.json({ returnedUsdc: fromBaseUnits(budgetAccount.amount, state.decimals), explorer: explorerTx(signature) });
});

// Repo analysis for people using the web app: free (covered by the ApiSift subscription). Agents that want
// the same analysis buy it per call from the paid /api/analyze service over x402.
office.post("/analyze", async (req, res) => {
  const projectId = String(req.body?.projectId ?? "").trim();
  const project = projectId ? findProject(projectId) : undefined;
  const repoUrl = String(req.body?.repoUrl ?? project?.repoUrl ?? "").trim();
  if (!repoUrl) throw new UserError("Paste a GitHub repository link.");
  if (!analyzerConfigured()) throw new UserError("The analyzer isn't configured on this server (ANTHROPIC_API_KEY is missing from .env).");
  const repo = await readGithubRepo(repoUrl);

  // The analyzer caps `prompt` at 500 characters, so it only gets a short description; the dependency
  // manifest (the strongest signal of what the code calls) goes first in the longer README field.
  const prompt = [`GitHub repository ${repo.fullName}${repo.description ? `: ${repo.description}` : ""}`, repo.language && `Main language: ${repo.language}`]
    .filter(Boolean)
    .join(". ");
  const readme = [repo.manifest && `Dependencies (${repo.manifestPath}):\n${repo.manifest}`, repo.readme && `README:\n${repo.readme}`]
    .filter(Boolean)
    .join("\n\n");
  const result = await runAnalysis({ prompt, projectTree: repo.tree, readme });
  if (project && !project.repoUrl) saveProject({ ...project, repoUrl: repo.url });

  res.json({
    repo: {
      fullName: repo.fullName,
      url: repo.url,
      description: repo.description,
      language: repo.language,
      fileCount: repo.fileCount,
      partial: repo.partial,
    },
    recommendations: result.ok ? result.recommendations : [],
    error: result.ok ? null : result.error,
  });
});

const handleUserErrors: ErrorRequestHandler = (err, _req, res, next) => {
  if (err instanceof UserError) res.status(400).json({ error: err.message });
  else next(err);
};
office.use(handleUserErrors);
