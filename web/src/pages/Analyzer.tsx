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

  // Prefill the repo of the chosen project.
  const projectRepo = project?.repoUrl;
  useEffect(() => {
    if (projectRepo) setRepo((current) => current || projectRepo);
  }, [projectRepo]);

  async function analyze(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.analyze(repo.trim(), project?.id));
      refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="page-head">
        <p className="eyebrow">API Analyzer</p>
        <h1>Your repository already knows what it needs.</h1>
        <p className="lede">
          Paste a GitHub repository. ApiSift reads its code, README and dependencies, then recommends APIs that fit and says which ones
          your project's agent can pay for per call. Included in your subscription.
        </p>
      </section>

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
        {projects.length > 0 && (
          <div className="field">
            <label htmlFor="for-project">For project (optional)</label>
            <select id="for-project" value={projectId} onChange={(e) => setProjectId(e.target.value)} disabled={busy}>
              <option value="">No project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <button type="submit" className="btn primary" disabled={busy || !repo.trim()}>
          {busy ? "Analyzing…" : "Analyze repository"}
        </button>
      </form>

      {busy && (
        <section className="card progress" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          <ol>
            <li>Reading the repository from GitHub</li>
            <li>Claude matches the project to APIs in the catalog</li>
          </ol>
          <p className="hint">Usually 10 to 30 seconds.</p>
        </section>
      )}

      {error && <p className="notice notice-error">{error}</p>}
      {result && <AnalysisView result={result} projectId={project?.id} />}
    </>
  );
}

function AnalysisView({ result, projectId }: { result: AnalysisResult; projectId?: string }) {
  const { repo, recommendations } = result;
  const payable = recommendations.filter((r) => /^yes/i.test(r.agentPayable)).length;
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

      {result.error && <p className="notice notice-error">{result.error}</p>}

      {recommendations.length > 0 && (
        <p className="receipt receipt-ok">
          <span aria-hidden="true">✓</span> {recommendations.length} API{recommendations.length === 1 ? "" : "s"} fit this repository
          {payable > 0 && `, and ${payable} can be paid per call by an agent`}.{" "}
          {projectId && payable > 0 && <a href={`#/projects/${projectId}`}>Set the project's allowance →</a>}
        </p>
      )}

      {recommendations.length > 0 && (
        <div className="recs">
          {recommendations.map((r) => (
            <RecommendationCard key={r.name} rec={r} />
          ))}
        </div>
      )}
      {!result.error && recommendations.length === 0 && <p className="hint">No API in the catalog fits this repository yet.</p>}
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
