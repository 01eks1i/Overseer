import { config } from "./config";
import { useOffice, useRoute } from "./api";
import { Logo, ThemeToggle } from "./components/ui";
import { AnalyzerPage } from "./pages/Analyzer";
import { ProjectPage } from "./pages/ProjectDetail";
import { ProjectsPage } from "./pages/Projects";

export function App() {
  const route = useRoute();
  const { office, error, refresh } = useOffice();

  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="#/projects">
          <Logo />
          <span>ApiSift</span>
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
