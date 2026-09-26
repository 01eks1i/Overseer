// Client for the ApiSift office API (src/api/office.ts) plus a minimal hash router.
import { useCallback, useEffect, useState } from "react";
import { config } from "./config";

const BASE = `${config?.apiBaseUrl ?? "http://localhost:4020"}/api/office`;

export interface ProjectSummary {
  id: string;
  name: string;
  repoUrl?: string;
  owner: string;
  agent: string;
  tokenAccount: string;
  createdAt: string;
  budgetUsdc: string;
  allowanceUsdc: string;
  delegated: boolean;
  agentSol: number;
}

export interface Office {
  wallet: { address: string; tokenAccount: string; balanceUsdc: string };
  mint: string;
  decimals: number;
  analyzePriceUsdc: string;
  projects: ProjectSummary[];
}

export interface Recommendation {
  name: string;
  whatItDoes: string;
  whyItFits: string;
  pricingAndAuth: string;
  docsUrl: string;
  agentPayable: string;
}

export interface AnalysisResult {
  repo: {
    fullName: string;
    url: string;
    description: string | null;
    language: string | null;
    fileCount: number | null;
    /** Only README and dependency files were read (GitHub API limit). */
    partial: boolean;
  };
  priceUsdc: string | null;
  payment: { ok: true; explorer: string; amountUsdc: string } | { ok: false; reason: string; explorer?: string; amountUsdc: string } | null;
  refused: string | null;
  recommendations: Recommendation[];
  error: string | null;
  refund: string | null;
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error("The ApiSift API isn't reachable. Start it with `npm run api`.");
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (HTTP ${res.status})`);
  return data;
}

export const api = {
  office: () => call<Office>(""),
  createProject: (name: string, repoUrl: string) =>
    call<{ project: ProjectSummary; explorer: string }>("/projects", { name, repoUrl: repoUrl || undefined }),
  setAllowance: (id: string, amountUsdc: string) =>
    call<{ allowanceUsdc: string; toppedUpUsdc: string; explorer: string }>(`/projects/${id}/allowance`, { amountUsdc }),
  revoke: (id: string) => call<{ returnedUsdc: string; explorer: string }>(`/projects/${id}/revoke`, {}),
  analyze: (id: string, repoUrl: string) => call<AnalysisResult>(`/projects/${id}/analyze`, { repoUrl }),
};

/** Polls the office (wallet, projects, allowances) every few seconds. */
export function useOffice() {
  const [office, setOffice] = useState<Office | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    api.office().then(
      (o) => {
        setOffice(o);
        setError(null);
      },
      (e: Error) => setError(e.message),
    );
  }, []);
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
  }, [refresh]);
  return { office, error, refresh };
}

export type Route = { page: "projects" } | { page: "project"; id: string } | { page: "analyzer"; project?: string };

function parseRoute(hash: string): Route {
  const [path, query = ""] = hash.replace(/^#\/?/, "").split("?");
  const [section, id] = path.split("/");
  if (section === "analyzer") return { page: "analyzer", project: new URLSearchParams(query).get("project") ?? undefined };
  if (section === "projects" && id) return { page: "project", id: decodeURIComponent(id) };
  return { page: "projects" };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const onChange = () => {
      setRoute(parseRoute(location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export const go = (hash: string) => {
  location.hash = hash;
};
