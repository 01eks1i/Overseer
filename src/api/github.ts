// Reads a public GitHub repository (metadata, file tree, README, dependency manifest) for the API analyzer.
// Unauthenticated GitHub API calls are limited to 60/hour per IP (shared by everyone on the same network);
// set GITHUB_TOKEN in .env to raise that. When the limit is used up, README and dependency files are read
// from raw.githubusercontent.com instead, which doesn't count toward it (only the file tree is lost).

/** An error caused by the request (bad URL, private repo…), reported to the user as a 400. */
export class UserError extends Error {}

export interface RepoSnapshot {
  fullName: string;
  url: string;
  description: string | null;
  language: string | null;
  /** null when the GitHub API was unavailable and the file tree couldn't be read. */
  fileCount: number | null;
  /** File paths, capped so large repos stay within a reasonable prompt size. */
  tree: string;
  readme: string;
  manifestPath: string | null;
  manifest: string;
  /** True when only README and dependency files could be read (GitHub API rate limit). */
  partial: boolean;
}

class RateLimited extends Error {}

const CACHE_MS = 10 * 60_000;
const cache = new Map<string, { at: number; snapshot: RepoSnapshot }>();

const MAX_TREE_PATHS = 400;
const MAX_README_CHARS = 12_000;
const MAX_MANIFEST_CHARS = 6_000;
const MANIFESTS = ["package.json", "requirements.txt", "pyproject.toml", "go.mod", "Cargo.toml", "Gemfile", "composer.json"];
const IGNORED = /(^|\/)(node_modules|dist|build|vendor|\.git|\.next|target|__pycache__)\//;

export function parseRepoUrl(input: string): { owner: string; repo: string } {
  const match = input.trim().match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/i);
  if (!match) throw new UserError("That doesn't look like a GitHub repository link, e.g. https://github.com/owner/repo");
  return { owner: match[1], repo: match[2] };
}

export async function readGithubRepo(input: string): Promise<RepoSnapshot> {
  const { owner, repo } = parseRepoUrl(input);
  const key = `${owner}/${repo}`.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.snapshot;

  let snapshot: RepoSnapshot;
  try {
    snapshot = await readViaApi(owner, repo);
  } catch (error) {
    if (!(error instanceof RateLimited)) throw error;
    snapshot = await readViaRaw(owner, repo);
  }
  cache.set(key, { at: Date.now(), snapshot });
  return snapshot;
}

async function readViaApi(owner: string, repo: string): Promise<RepoSnapshot> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "ApiSift" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const api = `https://api.github.com/repos/${owner}/${repo}`;

  const metaRes = await fetch(api, { headers });
  if (metaRes.status === 404) throw new UserError(`Repository ${owner}/${repo} not found. It has to be public.`);
  if (metaRes.status === 403 || metaRes.status === 429) throw new RateLimited();
  if (!metaRes.ok) throw new Error(`GitHub answered ${metaRes.status} for ${owner}/${repo}`);
  const meta = (await metaRes.json()) as {
    full_name: string;
    html_url: string;
    description: string | null;
    language: string | null;
    default_branch: string;
  };

  const [treeRes, readmeRes] = await Promise.all([
    fetch(`${api}/git/trees/${encodeURIComponent(meta.default_branch)}?recursive=1`, { headers }),
    fetch(`${api}/readme`, { headers: { ...headers, Accept: "application/vnd.github.raw" } }),
  ]);
  const treeJson = treeRes.ok ? ((await treeRes.json()) as { tree?: { path: string; type: string }[] }) : {};
  const paths = (treeJson.tree ?? []).filter((e) => e.type === "blob" && !IGNORED.test(e.path)).map((e) => e.path);
  const readme = readmeRes.ok ? await readmeRes.text() : "";

  // The dependency manifest says which services the code already talks to.
  const manifestPath = MANIFESTS.find((m) => paths.includes(m)) ?? null;
  const manifest = manifestPath
    ? await fetch(`https://raw.githubusercontent.com/${meta.full_name}/${meta.default_branch}/${manifestPath}`).then((r) =>
        r.ok ? r.text() : "",
      )
    : "";

  return {
    fullName: meta.full_name,
    url: meta.html_url,
    description: meta.description,
    language: meta.language,
    fileCount: paths.length,
    tree: paths.slice(0, MAX_TREE_PATHS).join("\n") + (paths.length > MAX_TREE_PATHS ? `\n… and ${paths.length - MAX_TREE_PATHS} more files` : ""),
    readme: readme.slice(0, MAX_README_CHARS),
    manifestPath,
    manifest: manifest.slice(0, MAX_MANIFEST_CHARS),
    partial: false,
  };
}

/** Rate-limit fallback: README and dependency files straight from the default branch (main or master). */
async function readViaRaw(owner: string, repo: string): Promise<RepoSnapshot> {
  const files = ["README.md", "readme.md", "README", ...MANIFESTS];
  for (const branch of ["main", "master"]) {
    const texts = await Promise.all(
      files.map((file) =>
        fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${file}`).then((r) => (r.ok ? r.text() : null)),
      ),
    );
    const found = files.map((file, i) => ({ file, text: texts[i] })).filter((f): f is { file: string; text: string } => f.text !== null);
    if (!found.length) continue;
    const manifest = found.find((f) => MANIFESTS.includes(f.file));
    return {
      fullName: `${owner}/${repo}`,
      url: `https://github.com/${owner}/${repo}`,
      description: null,
      language: null,
      fileCount: null,
      tree: "",
      readme: (found.find((f) => /^readme/i.test(f.file))?.text ?? "").slice(0, MAX_README_CHARS),
      manifestPath: manifest?.file ?? null,
      manifest: (manifest?.text ?? "").slice(0, MAX_MANIFEST_CHARS),
      partial: true,
    };
  }
  throw new UserError(
    `Couldn't read ${owner}/${repo}. GitHub's API limit for this network is used up, and no README or dependency file was found on main or master. Add a GITHUB_TOKEN to .env, or check that the repository is public.`,
  );
}
