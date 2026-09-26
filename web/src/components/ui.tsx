import { useEffect, useState } from "react";
import type { ProjectSummary } from "../api";

export function projectStatus(p: ProjectSummary): { label: string; tone: "ok" | "warn" | "muted" } {
  if (p.delegated && Number(p.allowanceUsdc) > 0) return { label: "Active", tone: "ok" };
  if (p.delegated) return { label: "Used up", tone: "warn" };
  return { label: "No allowance", tone: "muted" };
}

export function StatusChip({ project }: { project: ProjectSummary }) {
  const s = projectStatus(project);
  return <span className={`chip chip-${s.tone}`}>{s.label}</span>;
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn small ghost"
      onClick={() =>
        navigator.clipboard.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => setCopied(false),
        )
      }
    >
      {copied ? "Copied" : label}
    </button>
  );
}

export function repoName(url: string) {
  return url.replace(/^https?:\/\/(www\.)?github\.com\//i, "").replace(/\.git$/, "");
}

export function useNow(intervalMs: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function ago(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

const THEME_KEY = "apisift-theme"; // same key as the ApiSift landing page

export function ThemeToggle() {
  const [theme, setTheme] = useState<string | null>(() => {
    try {
      return localStorage.getItem(THEME_KEY);
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (theme) document.documentElement.setAttribute("data-theme", theme);
    else document.documentElement.removeAttribute("data-theme");
  }, [theme]);
  const isDark = theme ? theme === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
  const toggle = () => {
    const next = isDark ? "light" : "dark";
    setTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Private mode or blocked storage: the toggle still works for this visit.
    }
  };
  return (
    <button type="button" className="btn small ghost theme" onClick={toggle} aria-label={`Switch to ${isDark ? "light" : "dark"} theme`}>
      {isDark ? "☀ Light" : "☾ Dark"}
    </button>
  );
}
