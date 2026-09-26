import { config } from "./config";
import { useOffice, useRoute } from "./api";
import { ThemeToggle } from "./components/ui";
import { AnalyzerPage } from "./pages/Analyzer";
import { ProjectPage } from "./pages/ProjectDetail";
import { ProjectsPage } from "./pages/Projects";

export function App() {
  const route = useRoute();
  const { office, error, refresh } = useOffice();

  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="/" title="ApiSift home">
          <img className="brand-logo brand-logo-light" src="/brand/apisift-logo-light.png" alt="ApiSift" width={125} height={32} />
          <img className="brand-logo brand-logo-dark" src="/brand/apisift-logo-dark.png" alt="ApiSift" width={125} height={32} />
        </a>
        <nav className="nav" aria-label="Main">
          <a href="#/projects" className={route.page === "analyzer" ? "" : "on"}>
            Projects
          </a>
          <a href="#/analyzer" className={route.page === "analyzer" ? "on" : ""}>
            API Analyzer
          </a>
        </nav>
        <div className="topbar-right">
          <span className="pill">
            <i className="dot" aria-hidden="true" /> Devnet · demo wallet
          </span>
          <ThemeToggle />
        </div>
      </header>

      <main className="main">
        {!config ? (
          <SetupNeeded />
        ) : (
          <>
            {error && (
              <p className="banner" role="alert">
                {error}
              </p>
            )}
            {!error && office?.stale && (
              <p className="banner banner-soft" role="status">
                {office.stale}. Showing balances from {new Date(office.updatedAt).toLocaleTimeString()}; they refresh as soon as Solana answers.
              </p>
            )}
            {route.page === "projects" && <ProjectsPage office={office} refresh={refresh} />}
            {route.page === "project" && <ProjectPage id={route.id} office={office} refresh={refresh} />}
            {route.page === "analyzer" && <AnalyzerPage office={office} refresh={refresh} preselect={route.project} />}
          </>
        )}
      </main>

      <footer className="footer">ApiSift · hackathon prototype on Solana devnet · test USDC has no real value</footer>
    </div>
  );
}

function SetupNeeded() {
  return (
    <section className="card setup">
      <h1>Run setup first</h1>
      <p>
        The app reads its addresses from <code>web/src/overseer.json</code>, which setup creates. From the repo root:
      </p>
      <pre>npm run setup{"\n"}npm run api</pre>
      <p>This page reloads by itself once the file exists.</p>
    </section>
  );
}
