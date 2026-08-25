"""Loading and shaping: damame export JSON -> pandas DataFrames."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Union

import pandas as pd


@dataclass
class DamameData:
    """A loaded damame export: everything as DataFrames, plus raw metadata."""

    export_schema: int
    damame_version: str
    exported_at: str
    sessions: pd.DataFrame = field(repr=False)
    findings: pd.DataFrame = field(repr=False)
    feedback: pd.DataFrame = field(repr=False)
    recurrence: pd.DataFrame = field(repr=False)

    # ——— convenience analyses (thin wrappers over analysis.py) ———
    def score_trend(self) -> pd.DataFrame:
        from .analysis import score_trend

        return score_trend(self)

    def waste_by_rule(self) -> pd.DataFrame:
        from .analysis import waste_by_rule

        return waste_by_rule(self)

    def rule_frequency(self) -> pd.DataFrame:
        from .analysis import rule_frequency

        return rule_frequency(self)

    def cache_efficiency(self) -> pd.DataFrame:
        from .analysis import cache_efficiency

        return cache_efficiency(self)

    def precision_over_time(self) -> pd.DataFrame:
        from .analysis import precision_over_time

        return precision_over_time(self)


def _sessions_frame(rows: list) -> pd.DataFrame:
    flat = []
    for s in rows:
        t = s.get("totals", {})
        sc = s.get("score", {})
        buckets = {f"score_{b['id'].replace('-', '_')}": b["score"] for b in sc.get("buckets", [])}
        flat.append(
            {
                "session_id": s["id"],
                "project": s.get("project"),
                "started_at": s.get("started_at"),
                "ended_at": s.get("ended_at"),
                "score_overall": sc.get("overall"),
                **buckets,
                "capabilities_exercised": len(sc.get("capabilities_exercised", [])),
                "tokens": t.get("tokens"),
                "fresh_tokens": t.get("fresh_tokens"),
                "cache_read_tokens": t.get("cache_read_tokens"),
                "cache_creation_tokens": t.get("cache_creation_tokens"),
                "input_tokens": t.get("input_tokens"),
                "output_tokens": t.get("output_tokens"),
                "turns": t.get("turns"),
                "human_turns": t.get("human_turns"),
                "tool_calls": t.get("tool_calls"),
                "tool_errors": t.get("tool_errors"),
                "compactions": t.get("compactions"),
                "subagent_runs": t.get("subagent_runs"),
                "findings_count": len(s.get("findings", [])),
            }
        )
    df = pd.DataFrame(flat)
    if not df.empty:
        df["started_at"] = pd.to_datetime(df["started_at"], errors="coerce", format="ISO8601", utc=True)
        df["ended_at"] = pd.to_datetime(df["ended_at"], errors="coerce", format="ISO8601", utc=True)
        df = df.sort_values("started_at").reset_index(drop=True)
    return df


def _findings_frame(rows: list) -> pd.DataFrame:
    flat = []
    for s in rows:
        for f in s.get("findings", []):
            flat.append(
                {
                    "session_id": s["id"],
                    "project": s.get("project"),
                    "session_started_at": s.get("started_at"),
                    **{k: f.get(k) for k in (
                        "rule_id", "rule_version", "category", "severity", "title",
                        "dedupe_key", "savings_tokens", "savings_ms", "savings_basis",
                    )},
                }
            )
    df = pd.DataFrame(flat)
    if not df.empty:
        df["session_started_at"] = pd.to_datetime(df["session_started_at"], errors="coerce", format="ISO8601", utc=True)
    return df


def load(path: Union[str, Path]) -> DamameData:
    """Load a `damame export` JSON file into DataFrames."""
    raw = json.loads(Path(path).read_text())
    schema = raw.get("export_schema")
    if schema != 1:
        raise ValueError(f"unsupported export_schema {schema!r}; this damame-py supports schema 1")
    sessions = raw.get("sessions", [])
    feedback = pd.DataFrame(raw.get("feedback", []))
    if not feedback.empty and "at" in feedback.columns:
        feedback["at"] = pd.to_datetime(feedback["at"], errors="coerce", format="ISO8601", utc=True)
    return DamameData(
        export_schema=schema,
        damame_version=raw.get("damame_version", "?"),
        exported_at=raw.get("exported_at", "?"),
        sessions=_sessions_frame(sessions),
        findings=_findings_frame(sessions),
        feedback=feedback,
        recurrence=pd.DataFrame(raw.get("recurrence", [])),
    )


def summary(data: DamameData) -> str:
    """A terse plain-text overview of an export — the 30-second read."""
    s = data.sessions
    lines = [
        f"damame export · schema {data.export_schema} · damame {data.damame_version} · {len(s)} sessions",
    ]
    if s.empty:
        return "\n".join(lines + ["(no sessions)"])
    lines.append(
        f"span: {s['started_at'].min():%Y-%m-%d} → {s['ended_at'].max():%Y-%m-%d}"
        f" · total tokens: {int(s['tokens'].sum()):,}"
    )
    lines.append(
        f"score: mean {s['score_overall'].mean():.0f} · best {int(s['score_overall'].max())}"
        f" · worst {int(s['score_overall'].min())}"
    )
    if not data.findings.empty:
        top = data.findings.groupby("rule_id").size().sort_values(ascending=False).head(3)
        lines.append("top rules: " + " · ".join(f"{r} ×{n}" for r, n in top.items()))
        wasted = data.findings["savings_tokens"].dropna().sum()
        if wasted > 0:
            lines.append(f"measured waste across sessions: {int(wasted):,} tokens")
    return "\n".join(lines)
