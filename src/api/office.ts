// ApiSift "office": projects, their allowances, and repo analysis, driven by the demo wallet.
// These routes sign with the demo wallet's key (keys/owner.json), so they only answer requests from this machine.
import { Router, type ErrorRequestHandler, type Request } from "express";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
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
import { paidFetch } from "../agent/paidFetch.js";
import { API_BASE_URL, requireState } from "../lib/config.js";
import { findProject, listProjects, newProjectId, saveProject, type Project } from "../lib/projects.js";
import { connection, explorerTx, fromBaseUnits, loadKeypair, memoInstruction, toBaseUnits } from "../lib/solana.js";
import { parseRepoUrl, readGithubRepo, UserError } from "./github.js";

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
  return sendAndConfirmTransaction(connection, tx, [admin, ...signers]);
}

function requireProject(req: Request): Project {
  const project = findProject(String(req.params.id));
  if (!project) throw new UserError(`No project called "${req.params.id}"`);
  return project;
}

office.get("/", async (_req, res) => {
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

  res.json({
    wallet: { address: owner.toBase58(), tokenAccount: wallet.toBase58(), balanceUsdc: tokenInfo(0)?.tokenAmount.uiAmountString ?? "0" },
    mint: state.mint,
    decimals: state.decimals,
    analyzePriceUsdc: "0.25",
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
  });
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

// Reads a GitHub repo (free), then has the project's agent buy an analysis from the paid API via x402.
office.post("/projects/:id/analyze", async (req, res) => {
  const project = requireProject(req);
  const repoUrl = String(req.body?.repoUrl ?? project.repoUrl ?? "").trim();
  if (!repoUrl) throw new UserError("Paste a GitHub repository link.");
  const repo = await readGithubRepo(repoUrl); // bad links and private repos fail here, before anything is paid

  const prompt = [
    `GitHub repository ${repo.fullName}${repo.description ? `: ${repo.description}` : ""}`,
    repo.language && `Main language: ${repo.language}`,
    repo.manifest && `Dependencies (${repo.manifestPath}):\n${repo.manifest}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const result = await paidFetch(`${API_BASE_URL}/api/analyze`, {
    method: "POST",
    body: JSON.stringify({ prompt, projectTree: repo.tree, readme: repo.readme }),
    project: project.id,
  });
  if (!project.repoUrl) saveProject({ ...project, repoUrl: repo.url });

  const body = (result.body ?? {}) as { recommendations?: unknown[]; error?: string; refund?: string };
  res.json({
    repo: {
      fullName: repo.fullName,
      url: repo.url,
      description: repo.description,
      language: repo.language,
      fileCount: repo.fileCount,
      partial: repo.partial,
    },
    priceUsdc: result.priceUsdc ?? null,
    payment: result.payment ?? null,
    refused: result.refused ?? null,
    recommendations: body.recommendations ?? [],
    error: result.status >= 400 && result.payment?.ok !== false ? (body.error ?? `The analyzer answered HTTP ${result.status}`) : null,
    refund: body.refund ?? null,
  });
});

const handleUserErrors: ErrorRequestHandler = (err, _req, res, next) => {
  if (err instanceof UserError) res.status(400).json({ error: err.message });
  else next(err);
};
office.use(handleUserErrors);
