// ApiSift projects. Each project has its own agent key (keys/agent-<id>.json) and its own token account,
// owned by the demo wallet, that holds the project's budget. The agent is that account's delegate, so
// every project gets a separate spending limit enforced by the Token program (an account has one delegate).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT } from "./config.js";

export interface Project {
  id: string;
  name: string;
  repoUrl?: string;
  /** Wallet that owns the budget account (the demo wallet). */
  owner: string;
  agent: string;
  /** Token account holding the project's budget; the agent is its delegate. */
  tokenAccount: string;
  createdAt: string;
}

const PROJECTS_FILE = join(ROOT, ".overseer", "projects.json");

export function listProjects(): Project[] {
  return existsSync(PROJECTS_FILE) ? (JSON.parse(readFileSync(PROJECTS_FILE, "utf8")) as Project[]) : [];
}

/** Finds a project by id, or by name (case-insensitive) so agents can say "the sol-ticker project". */
export function findProject(idOrName: string): Project | undefined {
  const projects = listProjects();
  const key = idOrName.trim().toLowerCase();
  return projects.find((p) => p.id === key) ?? projects.find((p) => p.name.toLowerCase() === key);
}

export function saveProject(project: Project): void {
  const projects = listProjects().filter((p) => p.id !== project.id);
  projects.push(project);
  mkdirSync(dirname(PROJECTS_FILE), { recursive: true });
  writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2) + "\n");
}

export function newProjectId(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "project";
  const taken = new Set(listProjects().map((p) => p.id));
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}
