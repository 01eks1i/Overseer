import { useState, type FormEvent } from "react";
import { api, go, type Office } from "../api";
import { explorerAddress, shorten } from "../overseer";
import { StatusChip, repoName } from "../components/ui";

export function ProjectsPage({ office, refresh }: { office: Office | null; refresh: () => void }) {
  const [name, setName] = useState("");
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { project } = await api.createProject(name.trim(), repo.trim());
      refresh();
      go(`#/projects/${project.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="page-head">
        <p className="eyebrow">Your office</p>
        <h1>Projects</h1>
        <p className="lede">
          Each project gets its own budget and its own agent. Solana enforces every project's spending limit separately, so an agent can
          only ever spend what you gave its project.
        </p>
      </section>

      {office && (
        <section className="wallet-strip" aria-label="Demo wallet">
          <span className="wallet-label">Demo wallet</span>
          <a className="mono" href={explorerAddress(office.wallet.address)} target="_blank" rel="noreferrer">
            {shorten(office.wallet.address)} ↗
          </a>
          <span className="wallet-balance">
            <strong>{office.wallet.balanceUsdc}</strong> USDC available
          </span>
          <span className="hint">Test USDC on devnet, no real value</span>
        </section>
      )}

      <div className="projects-grid">
        {!office && <p className="hint">Loading projects…</p>}
        {office?.projects.map((p) => (
          <a key={p.id} className="card project-card" href={`#/projects/${p.id}`}>
            <div className="card-top">
              <h3>{p.name}</h3>
              <StatusChip project={p} />
            </div>
            {p.repoUrl && <div className="repo mono">{repoName(p.repoUrl)}</div>}
            <div className="amount">
              <span className="num">{p.allowanceUsdc}</span>
              <span className="unit">USDC allowance left</span>
            </div>
            <div className="card-foot">
              <span>Budget {p.budgetUsdc} USDC</span>
              <span className="mono">Agent {shorten(p.agent)}</span>
            </div>
          </a>
        ))}

        <form className="card new-project" onSubmit={create}>
          <h3>New project</h3>
          <label htmlFor="project-name">Name</label>
          <input id="project-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sol Ticker" maxLength={40} required />
          <label htmlFor="project-repo">GitHub repository (optional)</label>
          <input id="project-repo" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="https://github.com/you/repo" />
          <button type="submit" className="btn primary" disabled={busy || !name.trim()}>
            {busy ? "Creating on Solana…" : "Create project"}
          </button>
          <p className="hint">Opens a budget account and an agent key on Solana devnet. Takes a few seconds.</p>
          {error && <p className="notice notice-error">{error}</p>}
        </form>
      </div>
    </>
  );
}
