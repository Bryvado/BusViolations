import pandas as pd

from bus_violations.web_export import _summarize


def test_summary_preserves_daily_granularity_and_totals():
    frame = pd.DataFrame(
        {
            "issue_date": pd.to_datetime(
                ["2026-07-01 08:30", "2026-07-01 17:45", "2026-07-02 09:15"]
            ),
            "violation_type": ["Moving"] * 3,
            "agency": ["MPD"] * 3,
            "violation": ["SPEED"] * 3,
            "plate_state": ["DC"] * 3,
            "fine_amount": [100.0] * 3,
            "total_paid": [100.0, 0.0, 50.0],
        }
    )

    summary = _summarize(frame)

    assert len(summary) == 2
    assert summary["issue_date"].dt.hour.eq(0).all()
    assert summary["violation_count"].sum() == 3
    assert summary["fine_total"].sum() == 300.0
    assert summary["paid_total"].sum() == 150.0
