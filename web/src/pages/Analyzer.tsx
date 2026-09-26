import { useEffect, useState, type FormEvent } from "react";
import { api, type AnalysisResult, type Office, type Recommendation } from "../api";

export function AnalyzerPage({ office, refresh, preselect }: { office: Office | null; refresh: () => void; preselect?: string }) {
  const [repo, setRepo] = useState("");
  const [projectId, setProjectId] = useState(preselect ?? "");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const projects = office?.projects ?? [];
  const project = projects.find((p) => p.id === projectId);
  const price = office?.analyzePriceUsdc ?? "0.25";

  // Default to the preselected (or first) project, and prefill its repo.
  useEffect(() => {
    if (!projectId && projects.length) setProjectId(projects[0].id);
  }, [projectId, projects]);
  const projectRepo = project?.repoUrl;
  useEffect(() => {
    if (projectRepo) setRepo((current) => current || projectRepo);
  }, [projectRepo]);

  async function analyze(e: FormEvent) {
    e.preventDefault();
    if (!project) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.analyze(project.id, repo.trim()));
      refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const belowPrice = project && Number(project.allowanceUsdc) < Number(price);

  return (
    <>
      <section className="page-head">
        <p className="eyebrow">API Analyzer</p>
        <h1>Your repository already knows what it needs.</h1>
        <p className="lede">
          Paste a GitHub repository. ApiSift reads its code, README and dependencies, then recommends APIs that fit and says which ones an
          agent can pay for per call. The project's agent pays {price} USDC for each analysis, on Solana.
        </p>
      </section>

      {office && projects.length === 0 ? (
        <section className="card">
          <p>
            Analyses are paid from a project's budget. <a href="#/projects">Create a project first →</a>
          </p>
        </section>
      ) : (
        <form className="card analyze-form" onSubmit={analyze}>
          <div className="field grow">
            <label htmlFor="repo-url">GitHub repository</label>
            <input
              id="repo-url"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="https://github.com/owner/repo"
              required
              disabled={busy}
            />
          </div>
          <div className="field">
            <label htmlFor="pay-project">Paid by project</label>
            <select id="pay-project" value={projectId} onChange={(e) => setProjectId(e.target.value)} disabled={busy}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.allowanceUsdc} USDC left
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="btn primary" disabled={busy || !project || !repo.trim()}>
            {busy ? "Analyzing…" : `Analyze · ${price} USDC`}
          </button>
          {belowPrice && !busy && (
            <p className="hint warn full">
              {project.name}'s allowance ({project.allowanceUsdc} USDC) is below the price, so Solana will block this payment.{" "}
              <a href={`#/projects/${project.id}`}>Raise the allowance</a>
            </p>
          )}
        </form>
      )}

      {busy && (
        <section className="card progress" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          <ol>
            <li>Reading the repository from GitHub</li>
            <li>
              {project?.name}'s agent pays {price} USDC on Solana (x402)
            </li>
            <li>Claude matches the project to APIs in the catalog</li>
          </ol>
          <p className="hint">Usually 10 to 30 seconds.</p>
        </section>
      )}

      {error && <p className="notice notice-error">{error}</p>}
      {result && <AnalysisView result={result} projectName={project?.name ?? "The project"} projectId={projectId} />}
    </>
  );
}

function AnalysisView({ result, projectName, projectId }: { result: AnalysisResult; projectName: string; projectId: string }) {
  const { repo, payment, refund, recommendations } = result;
  return (
    <section className="results" aria-label="Analysis">
      <div className="result-head">
        <a className="mono" href={repo.url} target="_blank" rel="noreferrer">
          {repo.fullName} ↗
        </a>
        <span className="hint">
          {[repo.language, repo.fileCount !== null && `${repo.fileCount} files`, repo.description, repo.partial && "read README and dependencies only (GitHub API limit)"]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>

      {payment?.ok && (
        <p className="receipt receipt-ok">
          <span aria-hidden="true">✓</span> {projectName}'s agent paid {payment.amountUsdc} USDC for this analysis.{" "}
          <a href={payment.explorer} target="_blank" rel="noreferrer">
            View on Explorer ↗
          </a>
        </p>
      )}
      {payment && !payment.ok && (
        <p className="receipt receipt-blocked">
          <span aria-hidden="true">✕</span> <strong>Blocked by Solana.</strong> {payment.reason}{" "}
          {payment.explorer && (
            <a href={payment.explorer} target="_blank" rel="noreferrer">
              Failed transaction ↗
            </a>
          )}{" "}
          <a href={`#/projects/${projectId}`}>Raise the allowance →</a>
        </p>
      )}
      {result.refused && <p className="receipt receipt-blocked">{result.refused}</p>}
      {refund && (
        <p className="receipt receipt-refund">
          <span aria-hidden="true">↩</span> The analysis failed, so the payment was refunded to {projectName}'s budget.{" "}
          <a href={refund} target="_blank" rel="noreferrer">
            Refund on Explorer ↗
          </a>
        </p>
      )}
      {result.error && <p className="notice notice-error">{result.error}</p>}

      {recommendations.length > 0 && (
        <div className="recs">
          {recommendations.map((r) => (
            <RecommendationCard key={r.name} rec={r} />
          ))}
        </div>
      )}
      {payment?.ok && !result.error && recommendations.length === 0 && (
        <p className="hint">No API in the catalog fits this repository yet.</p>
      )}
    </section>
  );
}

function RecommendationCard({ rec }: { rec: Recommendation }) {
  const agentPayable = /^yes/i.test(rec.agentPayable);
  return (
    <article className={`card rec${agentPayable ? " rec-payable" : ""}`}>
      <div className="rec-top">
        <h3>{rec.name}</h3>
        <span className={`badge${agentPayable ? " badge-accent" : ""}`}>{agentPayable ? "Agent can pay per call" : "Needs an account or key"}</span>
      </div>
      <p className="rec-why">{rec.whyItFits}</p>
      <p className="rec-what">{rec.whatItDoes}</p>
      <dl className="rec-meta">
        <dt>Pricing and auth</dt>
        <dd>{rec.pricingAndAuth}</dd>
      </dl>
      <a href={rec.docsUrl} target="_blank" rel="noreferrer">
        Docs ↗
      </a>
    </article>
  );
}
