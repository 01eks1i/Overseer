import { useRef } from "react";
import { explorerTx, type Activity } from "../overseer";
import { ago, useNow } from "./ui";

const ICONS: Record<Activity["kind"], string> = {
  paid: "✓",
  blocked: "✕",
  refunded: "↩",
  allowance: "＋",
  revoked: "⦸",
  funded: "↓",
  withdrawn: "↑",
  created: "✦",
  failed: "!",
};

export function ActivityFeed({ activity, error }: { activity: Activity[]; error: string | null }) {
  const now = useNow(5000);
  // Rows that arrive after the first load animate in, so new payments catch the eye during the demo.
  const initial = useRef<Set<string> | null>(null);
  if (initial.current === null && activity.length) initial.current = new Set(activity.map((a) => a.signature));

  return (
    <section className="card feed" aria-labelledby="feed-title">
      <div className="card-head">
        <h2 id="feed-title">Live activity</h2>
        <span className={`live${error ? " stale" : ""}`}>
          <i aria-hidden="true" /> {error ? "Reconnecting to Solana" : "Live from Solana devnet"}
        </span>
      </div>
      {error && <p className="hint warn">{error}</p>}
      {activity.length === 0 ? (
        <div className="empty">
          <p>No activity yet.</p>
          <p className="hint">Set an allowance, then let the agent pay for an API. Payments appear here within seconds.</p>
        </div>
      ) : (
        <ol className="feed-list">
          {activity.map((a) => (
            <li key={a.signature} className={`row row-${a.kind}${initial.current?.has(a.signature) ? "" : " fresh"}`}>
              <span className="row-icon" aria-hidden="true">
                {ICONS[a.kind]}
              </span>
              <div className="row-main">
                <div className="row-title">{a.title}</div>
                {a.detail && <div className="row-detail">{a.detail}</div>}
              </div>
              <div className="row-meta">
                <span>{a.time ? ago(now - a.time * 1000) : "just now"}</span>
                <a href={explorerTx(a.signature)} target="_blank" rel="noreferrer">
                  Explorer ↗
                </a>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
