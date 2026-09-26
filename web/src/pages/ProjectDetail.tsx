import { useState, type FormEvent } from "react";
import { api, type Office, type ProjectSummary } from "../api";
import { ActivityFeed } from "../components/ActivityFeed";
import { CopyButton, StatusChip, repoName } from "../components/ui";
import { explorerAddress, fromBaseUnits, shorten, toBaseUnits, useActivity } from "../overseer";

type Notice = { kind: "ok" | "error"; text: string; link?: string };

const PRESETS = ["0.10", "0.50", "1.00"];

export function ProjectPage({ id, office, refresh }: { id: string; office: Office | null; refresh: () => void }) {
  if (!office) return <p className="hint">Loading project…</p>;
  const project = office.projects.find((p) => p.id === id);
  if (!project) {
    return (
      <section className="page-head">
        <h1>Project not found</h1>
        <p className="lede">
          There's no project called "{id}". <a href="#/projects">Back to your projects</a>
        </p>
      </section>
    );
  }
  return <ProjectView key={project.id} project={project} decimals={office.decimals} analyzePrice={office.analyzePriceUsdc} refresh={refresh} />;
}

function ProjectView({
  project: p,
  decimals,
  analyzePrice,
  refresh,
}: {
  project: ProjectSummary;
  decimals: number;
  analyzePrice: string;
  refresh: () => void;
}) {
  const feed = useActivity(p.tokenAccount, p.agent, decimals);
  const [amount, setAmount] = useState("0.50");
  const [pending, setPending] = useState<"allowance" | "revoke" | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  // The latest allowance event says what was granted, as long as the agent is still the delegate.
  const lastGrant = feed.activity.find((a) => a.kind === "allowance" || a.kind === "revoked");
  const remaining = toBaseUnits(p.allowanceUsdc, decimals);
  const granted = p.delegated && lastGrant?.kind === "allowance" && lastGrant.amount ? toBaseUnits(lastGrant.amount, decimals) : null;
  const pct = granted ? Math.max(0, Math.min(100, Number((remaining * 10000n) / granted) / 100)) : 0;

  async function run(kind: "allowance" | "revoke", action: () => Promise<{ explorer: string }>, success: string) {
    setPending(kind);
    setNotice(null);
    try {
      const { explorer } = await action();
      setNotice({ kind: "ok", text: success, link: explorer });
      refresh();
      feed.refresh();
    } catch (err) {
      setNotice({ kind: "error", text: (err as Error).message });
    } finally {
      setPending(null);
    }
  }

  function setAllowance(e: FormEvent) {
    e.preventDefault();
    void run("allowance", () => api.setAllowance(p.id, amount), `Allowance set to ${amount} USDC.`);
  }

  const envSnippet = `"env": { "APISIFT_PROJECT": "${p.id}" }`;

  return (
    <>
      <a className="back" href="#/projects">
        ← Projects
      </a>
      <section className="page-head page-head-row">
        <div>
          <p className="eyebrow">Project</p>
          <h1>{p.name}</h1>
          {p.repoUrl && (
            <a className="mono repo-link" href={p.repoUrl} target="_blank" rel="noreferrer">
              {repoName(p.repoUrl)} ↗
            </a>
          )}
        </div>
        <a className="btn secondary" href={`#/analyzer?project=${p.id}`}>
          Analyze repo · {analyzePrice} USDC
        </a>
      </section>

      <div className="split">
        <div className="col">
          <section className="card allowance" aria-labelledby="allowance-title">
            <div className="card-head">
              <h2 id="allowance-title">Remaining allowance</h2>
              <StatusChip project={p} />
            </div>
            <div className="big-number">
              <span className="num">{fromBaseUnits(remaining, decimals)}</span>
              <span className="unit">USDC</span>
            </div>
            <div className="meter" role="img" aria-label={`${pct}% of the allowance left`}>
              <i style={{ width: `${pct}%` }} />
            </div>
            <p className="meter-caption">
              {granted !== null
                ? `of ${fromBaseUnits(granted, decimals)} granted · ${fromBaseUnits(granted > remaining ? granted - remaining : 0n, decimals)} spent · budget ${p.budgetUsdc} USDC`
                : `Budget ${p.budgetUsdc} USDC. Set an allowance so the agent can pay for APIs.`}
            </p>

            <form className="controls" onSubmit={setAllowance}>
              <label htmlFor="allowance-amount">New allowance (USDC)</label>
              <div className="presets">
                {PRESETS.map((preset) => (
                  <button
                    type="button"
                    key={preset}
                    className={`preset${amount === preset ? " on" : ""}`}
                    onClick={() => setAmount(preset)}
                    disabled={pending !== null}
                  >
                    {preset}
                  </button>
                ))}
              </div>
              <div className="control-row">
                <input
                  id="allowance-amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                  disabled={pending !== null}
                />
                <button type="submit" className="btn primary" disabled={pending !== null}>
                  {pending === "allowance" ? "Signing…" : "Set allowance"}
                </button>
              </div>
              <button
                type="button"
                className="btn danger"
                onClick={() => void run("revoke", () => api.revoke(p.id), "Allowance revoked. The unused budget went back to the wallet.")}
                disabled={pending !== null || (!p.delegated && Number(p.budgetUsdc) === 0)}
              >
                {pending === "revoke" ? "Signing…" : "Revoke and return budget"}
              </button>
              <p className="hint">Signed by the demo wallet. Setting an allowance moves that much USDC into the project budget.</p>
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
            <Fact label="Agent" value={shorten(p.agent)} href={explorerAddress(p.agent)} />
            <Fact label="Budget account" value={shorten(p.tokenAccount)} href={explorerAddress(p.tokenAccount)} />
            <Fact label="Budget" value={`${p.budgetUsdc} USDC`} />
            <Fact label="Agent SOL for fees" value={p.agentSol.toFixed(4)} />
          </section>

          <section className="card connect" aria-labelledby="connect-title">
            <h2 id="connect-title">Connect your agent</h2>
            <p>Claude pays from this project when the Overseer MCP server in <code>.mcp.json</code> has:</p>
            <div className="snippet">
              <code>{envSnippet}</code>
              <CopyButton text={envSnippet} />
            </div>
            <p className="hint">Or tell Claude to use the "{p.name}" project.</p>
          </section>
        </div>

        <ActivityFeed activity={feed.activity} error={feed.error} />
      </div>
    </>
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
