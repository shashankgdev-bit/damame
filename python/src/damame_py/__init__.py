"""damame-py — session-over-session analytics for damame exports.

Usage:
    damame export --out export.json          # in your shell (the TS CLI)

    import damame_py as dm
    data = dm.load("export.json")
    data.sessions          # one row per session: score, totals, dates
    data.findings          # one row per finding, joined with session context
    data.score_trend()     # overall + per-parameter scores over time
    data.waste_by_rule()   # measured wasted tokens per rule
    print(dm.summary(data))

The export schema is versioned (export_schema); this package supports schema 1.
"""

from .core import DamameData, load, summary
from . import analysis

__all__ = ["DamameData", "load", "summary", "analysis"]
__version__ = "0.1.0"
SUPPORTED_EXPORT_SCHEMA = 1
