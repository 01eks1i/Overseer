import { useEffect, useRef, useState, type FormEvent } from "react";
import { PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { createApproveCheckedInstruction, createRevokeInstruction } from "@solana/spl-token";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { config, type OverseerConfig } from "./config";
import {
  explorerAddress,
  explorerTx,
  fromBaseUnits,
  memoInstruction,
  shorten,
  toBaseUnits,
  useOverseerData,
  useServices,
  type Activity,
} from "./overseer";

export function App() {
  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">
          <EyeMark />
          <div>
            <div className="brand-name">Overseer</div>
            <div className="brand-tag">Spending limits for AI agents, enforced by Solana</div>
          </div>
        </div>
        <div className="topbar-right">
          <span className="network">Devnet</span>
          <WalletMultiButton />
        </div>
      </header>
      {config ? <Dashboard cfg={config} /> : <SetupNeeded />}
    </div>
  );
}

function SetupNeeded() {
  return (
    <main className="setup card">
      <h1>Run setup first</h1>
      <p>The dashboard reads its addresses from <code>web/src/overseer.json</code>, which setup creates. From the repo root:</p>
      <pre>npm run setup{"\n"}npm run fund -- &lt;your devnet wallet address&gt;</pre>
      <p>This page reloads by itself once the file exists.</p>
    </main>
  );
}

type Notice = { kind: "ok" | "error"; text: string; link?: string };

const PRESETS = ["0.05", "0.10", "1.00"];

function Dashboard({ cfg }: { cfg: OverseerConfig }) {
  const { connection } = useConnection();
  const { publicKey, signTransaction, sendTransaction } = useWallet();
  const data = useOverseerData(connection, cfg);
  const services = useServices(cfg.apiBaseUrl);
  const [amount, setAmount] = useState("0.10");
  const [pending, setPending] = useState<"approve" | "revoke" | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const connected = publicKey?.toBase58() ?? null;
  const isOwner = connected === cfg.owner;
  const delegatedToAgent = data.account?.delegate === cfg.agent;
  const remaining = delegatedToAgent ? data.account!.delegatedAmount : 0n;

  // The most recent allowance event tells us what was granted (unless it was revoked since).
  const lastEvent = data.activity.find((a) => a.kind === "allowance" || a.kind === "revoked");
  const granted = lastEvent?.kind === "allowance" && delegatedToAgent && lastEvent.amount ? toBaseUnits(lastEvent.amount, cfg.decimals) : null;
  const spent = granted !== null && granted >= remaining ? granted - remaining : null;
  const pct = granted ? Math.max(0, Math.min(100, Number((remaining * 10000n) / granted) / 100)) : 0;

  const status =
    data.account === undefined
      ? { label: "Loading", tone: "muted" }
      : delegatedToAgent && remaining > 0n
        ? { label: "Active", tone: "ok" }
        : delegatedToAgent
          ? { label: "Used up", tone: "warn" }
          : lastEvent?.kind === "revoked"
            ? { label: "Revoked", tone: "danger" }
            : { label: "No allowance", tone: "muted" };

  async function submit(kind: "approve" | "revoke", instructions: TransactionInstruction[], successText: string) {
    if (!publicKey) return;
    setPending(kind);
    setNotice(null);
    try {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      const tx = new Transaction({ feePayer: publicKey, blockhash, lastValidBlockHeight }).add(...instructions);
      // Sign in the wallet but send through our own devnet connection, whatever network the wallet shows.
      const signature = signTransaction
        ? await connection.sendRawTransaction((await signTransaction(tx)).serialize())
        : await sendTransaction(tx, connection);
      const result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
      if (result.value.err) throw new Error("The transaction failed on-chain.");
      setNotice({ kind: "ok", text: successText, link: explorerTx(signature) });
      data.refresh();
    } catch (e) {
      const message = (e as Error).message ?? String(e);
      setNotice({ kind: "error", text: /reject|cancel|declin/i.test(message) ? "Cancelled in your wallet." : message });
    } finally {
      setPending(null);
    }
  }

  function approve(e: FormEvent) {
    e.preventDefault();
    if (!publicKey) return;
    let units: bigint;
    try {
      units = toBaseUnits(amount, cfg.decimals);
    } catch {
      units = 0n;
    }
    if (units <= 0n) {
      setNotice({ kind: "error", text: "Enter an amount above 0, like 0.10." });
      return;
    }
    const pretty = fromBaseUnits(units, cfg.decimals);
    void submit(
      "approve",
      [
        createApproveCheckedInstruction(
          new PublicKey(data.ownerTokenAccount),
          new PublicKey(cfg.mint),
          new PublicKey(cfg.agent),
          publicKey,
          units,
          cfg.decimals,
        ),
        memoInstruction(`overseer: allowance set to ${pretty} USDC`),
      ],
      `Allowance set to ${pretty} USDC.`,
    );
  }

  function revoke() {
    if (!publicKey) return;
    void submit(
      "revoke",
      [createRevokeInstruction(new PublicKey(data.ownerTokenAccount), publicKey), memoInstruction("overseer: allowance revoked")],
      "Allowance revoked. The agent can't spend anything now.",
    );
  }

  const controlsDisabled = !isOwner || pending !== null || data.account === null;
  const controlsHint = !connected
    ? "Connect the owner's wallet to change the allowance."
    : !isOwner
      ? "This wallet isn't the one the agent spends from."
      : data.account === null
        ? "This wallet has no test USDC account yet. Run npm run fund for it."
        : null;

  return (
    <main className="grid">
      {connected && !isOwner && <OwnerMismatch connected={connected} owner={cfg.owner} />}

      <div className="col">
        <section className="card allowance" aria-labelledby="allowance-title">
          <div className="card-head">
            <h2 id="allowance-title">Remaining allowance</h2>
            <span className={`chip chip-${status.tone}`}>{status.label}</span>
          </div>
          <div className="big-number">
            <span className="num">{data.account === undefined ? "…" : fromBaseUnits(remaining, cfg.decimals)}</span>
            <span className="unit">USDC</span>
          </div>
          <div className="meter" role="img" aria-label={`${pct}% of the allowance left`}>
            <i style={{ width: `${pct}%` }} />
          </div>
          <p className="meter-caption">
            {granted !== null
              ? `of ${fromBaseUnits(granted, cfg.decimals)} granted · ${fromBaseUnits(spent ?? 0n, cfg.decimals)} spent`
              : "Set an allowance to let the agent pay for services."}
          </p>

          <form className="controls" onSubmit={approve}>
            <label htmlFor="allowance-amount">New allowance (USDC)</label>
            <div className="presets">
              {PRESETS.map((p) => (
                <button type="button" key={p} className={`preset${amount === p ? " on" : ""}`} onClick={() => setAmount(p)} disabled={controlsDisabled}>
                  {p}
                </button>
              ))}
            </div>
            <div className="control-row">
              <input
                id="allowance-amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                disabled={controlsDisabled}
              />
              <button type="submit" className="btn primary" disabled={controlsDisabled}>
                {pending === "approve" ? "Confirm in wallet…" : "Set allowance"}
              </button>
            </div>
            <button type="button" className="btn danger" onClick={revoke} disabled={controlsDisabled || !delegatedToAgent}>
              {pending === "revoke" ? "Confirm in wallet…" : "Revoke agent's access"}
            </button>
            {controlsHint && <p className="hint">{controlsHint}</p>}
          </form>

          {notice && (
            <p className={`notice notice-${notice.kind}`} role="status">
              {notice.text}{" "}
              {notice.link && (
                <a href={notice.link} target="_blank" rel="noreferrer">
                  View on Explorer ↗
                </a>
              )}
            </p>
          )}
        </section>

        <section className="card facts" aria-label="Accounts">
          <Fact label="Owner wallet" value={shorten(cfg.owner)} href={explorerAddress(cfg.owner)} />
          <Fact label="Owner balance" value={data.account ? `${fromBaseUnits(data.account.balance, cfg.decimals)} USDC` : "–"} />
          <Fact label="Agent" value={shorten(cfg.agent)} href={explorerAddress(cfg.agent)} />
          <Fact label="Agent SOL for fees" value={data.agentSol === null ? "–" : data.agentSol.toFixed(4)} />
        </section>

        <section className="card services" aria-labelledby="services-title">
          <div className="card-head">
            <h2 id="services-title">Services the agent can buy</h2>
          </div>
          {services === null ? (
            <p className="hint">
              The paid API isn't reachable at {cfg.apiBaseUrl}. Start it with <code>npm run api</code>.
            </p>
          ) : (
            <ul className="service-list">
              {services.map((s) => (
                <li key={s.id}>
                  <div>
                    <div className="service-name">{s.description}</div>
                    <code className="service-path">
                      {s.method} {new URL(s.url).pathname}
                    </code>
                  </div>
                  <span className="price">{s.priceUsdc} USDC</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <ActivityFeed activity={data.activity} error={data.error} />
    </main>
  );
}

function Fact({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div className="fact">
      <span className="fact-label">{label}</span>
      {href ? (
        <a className="fact-value mono" href={href} target="_blank" rel="noreferrer">
          {value} ↗
        </a>
      ) : (
        <span className="fact-value mono">{value}</span>
      )}
    </div>
  );
}

function OwnerMismatch({ connected, owner }: { connected: string; owner: string }) {
  const command = `npm run fund -- ${connected}`;
  const [copied, setCopied] = useState(false);
  return (
    <div className="banner" role="alert">
      <div>
        <strong>The agent spends from {shorten(owner)}, not this wallet.</strong> To use this wallet, run this in the repo, then reload:
        <code className="banner-cmd">{command}</code>
      </div>
      <button
        type="button"
        className="btn small"
        onClick={() =>
          navigator.clipboard.writeText(command).then(
            () => setCopied(true),
            () => setCopied(false),
          )
        }
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

const ICONS: Record<Activity["kind"], string> = {
  paid: "✓",
  blocked: "✕",
  allowance: "＋",
  revoked: "⦸",
  funded: "↓",
  failed: "!",
};

function ActivityFeed({ activity, error }: { activity: Activity[]; error: string | null }) {
  const now = useNow(5000);
  // Rows that arrive after the first load animate in, so new payments catch the eye during the demo.
  const initial = useRef<Set<string> | null>(null);
  if (initial.current === null && activity.length) initial.current = new Set(activity.map((a) => a.signature));

  return (
    <section className="card feed" aria-labelledby="feed-title">
      <div className="card-head">
        <h2 id="feed-title">Live activity</h2>
        <span className="live">
          <i aria-hidden="true" /> Live from devnet
        </span>
      </div>
      {error && <p className="hint">Can't reach the RPC right now ({error}). Retrying…</p>}
      {activity.length === 0 ? (
        <div className="empty">
          <p>No activity yet.</p>
          <p className="hint">Set an allowance, then ask Claude to use a paid service. Payments show up here within seconds.</p>
        </div>
      ) : (
        <ol className="feed-list">
          {activity.map((a) => (
            <li key={a.signature} className={`row row-${a.kind}${initial.current?.has(a.signature) ? "" : " fresh"}`}>
              <span className="row-icon" aria-hidden="true">
                {ICONS[a.kind]}
              </span>
              <div className="row-main">
                <div className="row-title">{a.title}</div>
                {a.detail && <div className="row-detail">{a.detail}</div>}
              </div>
              <div className="row-meta">
                <span>{a.time ? ago(now - a.time * 1000) : "just now"}</span>
                <a href={explorerTx(a.signature)} target="_blank" rel="noreferrer">
                  Explorer ↗
                </a>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function useNow(intervalMs: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function ago(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

function EyeMark() {
  return (
    <svg className="mark" viewBox="0 0 32 32" aria-hidden="true">
      <path d="M2 16c3.6-6 8.4-9 14-9s10.4 3 14 9c-3.6 6-8.4 9-14 9S5.6 22 2 16Z" fill="none" stroke="currentColor" strokeWidth="2.4" />
      <circle cx="16" cy="16" r="5" fill="currentColor" />
    </svg>
  );
}
