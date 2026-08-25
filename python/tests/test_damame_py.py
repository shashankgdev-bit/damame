import json
from pathlib import Path

import pytest

import damame_py as dm

FIXTURE = {
    "export_schema": 1,
    "damame_version": "0.6.0",
    "exported_at": "2026-08-25T10:00:00Z",
    "sessions": [
        {
            "id": "aaa",
            "project": "/p/one",
            "started_at": "2026-08-01T09:00:00Z",
            "ended_at": "2026-08-01T11:00:00Z",
            "totals": {"tokens": 1_000_000, "fresh_tokens": 200_000, "input_tokens": 10_000,
                       "output_tokens": 90_000, "cache_read_tokens": 700_000, "cache_creation_tokens": 100_000,
                       "turns": 40, "human_turns": 10, "tool_calls": 100, "tool_errors": 2,
                       "compactions": 0, "subagent_runs": 3},
            "score": {"version": "score@1", "overall": 90,
                      "buckets": [{"id": "cost-efficiency", "score": 95}, {"id": "context-hygiene", "score": 85}],
                      "capabilities_exercised": ["subagents"]},
            "findings": [
                {"rule_id": "paste-relay", "rule_version": "0.1.1", "category": "missed-resource",
                 "severity": "moderate", "title": "t", "dedupe_key": "k1",
                 "savings_tokens": None, "savings_ms": None, "savings_basis": None},
            ],
            "techniques": {"subagent-delegation": 3},
        },
        {
            "id": "bbb",
            "project": "/p/one",
            "started_at": "2026-08-10T09:00:00Z",
            "ended_at": "2026-08-10T10:00:00Z",
            "totals": {"tokens": 500_000, "fresh_tokens": 100_000, "input_tokens": 5_000,
                       "output_tokens": 45_000, "cache_read_tokens": 400_000, "cache_creation_tokens": 50_000,
                       "turns": 20, "human_turns": 5, "tool_calls": 50, "tool_errors": 0,
                       "compactions": 1, "subagent_runs": 0},
            "score": {"version": "score@1", "overall": 70,
                      "buckets": [{"id": "cost-efficiency", "score": 80}, {"id": "context-hygiene", "score": 60}],
                      "capabilities_exercised": []},
            "findings": [
                {"rule_id": "cache-thrash", "rule_version": "0.1.0", "category": "context-hygiene",
                 "severity": "major", "title": "t", "dedupe_key": "k2",
                 "savings_tokens": 50_000, "savings_ms": None, "savings_basis": "measured"},
                {"rule_id": "paste-relay", "rule_version": "0.1.1", "category": "missed-resource",
                 "severity": "moderate", "title": "t", "dedupe_key": "k3",
                 "savings_tokens": None, "savings_ms": None, "savings_basis": None},
            ],
            "techniques": {},
        },
    ],
    "feedback": [
        {"key": "k2", "question": "accurate", "answer": True, "at": "2026-08-11T09:00:00Z"},
        {"key": "k2", "question": "applicable", "answer": False, "at": "2026-08-11T09:01:00Z"},
    ],
    "recurrence": [{"rule_id": "paste-relay", "rate_before": 2.0, "rate_after": 1.0, "verdict": "improving"}],
}


@pytest.fixture()
def export_file(tmp_path: Path) -> Path:
    p = tmp_path / "export.json"
    p.write_text(json.dumps(FIXTURE))
    return p


def test_load_shapes(export_file):
    data = dm.load(export_file)
    assert data.export_schema == 1
    assert len(data.sessions) == 2
    assert len(data.findings) == 3
    assert len(data.feedback) == 2
    assert list(data.sessions["score_overall"]) == [90, 70]  # sorted by date
    assert data.sessions.iloc[0]["session_id"] == "aaa"


def test_rejects_unknown_schema(tmp_path):
    p = tmp_path / "bad.json"
    p.write_text(json.dumps({"export_schema": 99}))
    with pytest.raises(ValueError, match="unsupported export_schema"):
        dm.load(p)


def test_waste_by_rule(export_file):
    w = dm.load(export_file).waste_by_rule()
    assert w.loc["cache-thrash", "wasted_tokens"] == 50_000
    assert w.loc["paste-relay", "occurrences"] == 2
    assert w.index[0] == "cache-thrash"  # ranked by waste


def test_score_trend_and_frequency(export_file):
    data = dm.load(export_file)
    trend = data.score_trend()
    assert list(trend["score_overall"]) == [90, 70]
    freq = data.rule_frequency()
    assert freq["paste-relay"].tolist() == [1, 1]
    assert freq["cache-thrash"].tolist() == [0, 1]


def test_cache_efficiency(export_file):
    ce = dm.load(export_file).cache_efficiency()
    # session aaa: 700k reads / (10k + 700k + 100k) ≈ 0.864
    assert abs(ce.iloc[0]["cache_share"] - 0.864) < 0.001


def test_precision_over_time(export_file):
    p = dm.load(export_file).precision_over_time()
    acc = p[p["question"] == "accurate"]
    assert acc.iloc[-1]["cumulative_yes_rate"] == 1.0


def test_summary_text(export_file):
    text = dm.summary(dm.load(export_file))
    assert "2 sessions" in text
    assert "score: mean 80" in text
