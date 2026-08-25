"""Session-over-session analyses. Each returns a plain DataFrame you can
inspect, plot, or join — no hidden state, no opinions beyond arithmetic."""

from __future__ import annotations

import pandas as pd

from .core import DamameData


def score_trend(data: DamameData) -> pd.DataFrame:
    """Overall + per-parameter scores per session, ordered by start date.

    The core question: is this person's practice improving across sessions?
    """
    s = data.sessions
    cols = ["session_id", "project", "started_at", "score_overall"] + [
        c for c in s.columns if c.startswith("score_") and c != "score_overall"
    ]
    return s[cols].set_index("started_at")


def waste_by_rule(data: DamameData) -> pd.DataFrame:
    """Measured wasted tokens summed per rule, with occurrence counts.

    Where the money actually leaks, ranked.
    """
    f = data.findings
    if f.empty:
        return pd.DataFrame(columns=["occurrences", "wasted_tokens"])
    g = f.groupby("rule_id").agg(
        occurrences=("dedupe_key", "count"),
        wasted_tokens=("savings_tokens", lambda x: int(x.dropna().sum())),
        worst_severity=("severity", lambda x: x.map({"major": 3, "moderate": 2, "minor": 1, "info": 0}).max()),
    )
    return g.sort_values("wasted_tokens", ascending=False)


def rule_frequency(data: DamameData) -> pd.DataFrame:
    """Findings per rule per session (rows: sessions in time order, cols: rules).

    A recurring column = a habit; a column that fades = an adopted fix.
    """
    f = data.findings
    if f.empty:
        return pd.DataFrame()
    pivot = f.pivot_table(
        index="session_started_at", columns="rule_id", values="dedupe_key", aggfunc="count", fill_value=0
    )
    return pivot.sort_index()


def cache_efficiency(data: DamameData) -> pd.DataFrame:
    """Per session: how much context was served from cache vs paid fresh.

    cache_share ≈ the fraction of input context re-served at ~10% price.
    """
    s = data.sessions
    out = s[["session_id", "project", "started_at", "tokens", "fresh_tokens", "cache_read_tokens"]].copy()
    denom = out["cache_read_tokens"] + out["input_tokens" if "input_tokens" in out else "fresh_tokens"]
    total_in = s["input_tokens"] + s["cache_read_tokens"] + s["cache_creation_tokens"]
    out["cache_share"] = (s["cache_read_tokens"] / total_in.replace(0, pd.NA)).astype(float).round(3)
    del denom
    return out.set_index("started_at")


def precision_over_time(data: DamameData) -> pd.DataFrame:
    """Cumulative accurate-rate and applicable-rate from the feedback log.

    The tool's own report card, as judged by its user, over time.
    """
    fb = data.feedback
    if fb.empty or "question" not in fb.columns:
        return pd.DataFrame(columns=["question", "cumulative_yes_rate", "n"])
    fb = fb.dropna(subset=["question", "answer"]).sort_values("at")
    frames = []
    for q, grp in fb.groupby("question"):
        g = grp.copy()
        g["n"] = range(1, len(g) + 1)
        g["cumulative_yes_rate"] = (g["answer"].astype(bool).cumsum() / g["n"]).round(3)
        frames.append(g[["at", "question", "cumulative_yes_rate", "n"]])
    return pd.concat(frames).set_index("at").sort_index()
