"""Analysis tables translated from the original Colab notebook."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


def exclude_incomplete_current_month(
    frame: pd.DataFrame,
    *,
    today: pd.Timestamp | None = None,
) -> pd.DataFrame:
    current_month = (today or pd.Timestamp.today()).to_period("M").strftime("%Y-%m")
    return frame.loc[frame["YEAR_MONTH"].lt(current_month)].copy()


def filter_records(
    frame: pd.DataFrame,
    *,
    agency: str | None = None,
    violation: str | None = None,
) -> pd.DataFrame:
    selected = frame.copy()
    if agency:
        selected = selected.loc[
            selected["ISSUING_AGENCY_SHORT"].str.contains(
                agency, case=False, na=False, regex=False
            )
        ]
    if violation:
        selected = selected.loc[
            selected["VIOLATION_PROCESS_DESC"].str.contains(
                violation, case=False, na=False, regex=False
            )
        ]
    return selected


def headline_metrics(frame: pd.DataFrame) -> dict[str, Any]:
    return {
        "rows": int(len(frame)),
        "date_min": frame["ISSUE_DATE"].min().date().isoformat(),
        "date_max": frame["ISSUE_DATE"].max().date().isoformat(),
        "fine_total": float(frame["FINE_AMOUNT"].sum()),
        "paid_total": float(frame["TOTAL_PAID"].fillna(0).sum()),
        "unpaid_fine_difference": float(frame["UNPAID"].sum()),
    }


def monthly_counts(frame: pd.DataFrame) -> pd.DataFrame:
    return (
        frame.groupby("YEAR_MONTH", as_index=False)
        .size()
        .rename(columns={"size": "violation_count"})
        .sort_values("YEAR_MONTH")
    )


def monthly_counts_by_type(frame: pd.DataFrame) -> pd.DataFrame:
    selected = frame.loc[
        frame["source_violation_type"].notna()
        & frame["source_violation_type"].ne("")
    ]
    return (
        selected.groupby(["YEAR_MONTH", "source_violation_type"], as_index=False)
        .size()
        .rename(columns={"size": "violation_count"})
        .sort_values(["YEAR_MONTH", "source_violation_type"])
    )


def monthly_payments(frame: pd.DataFrame) -> pd.DataFrame:
    return (
        frame.groupby("YEAR_MONTH", as_index=False)[["FINE_AMOUNT", "TOTAL_PAID"]]
        .sum()
        .sort_values("YEAR_MONTH")
    )


def top_agencies(frame: pd.DataFrame, count: int = 10) -> pd.DataFrame:
    return (
        frame["ISSUING_AGENCY_SHORT"]
        .value_counts()
        .head(count)
        .rename_axis("agency")
        .reset_index(name="violation_count")
    )


def agency_monthly_index(frame: pd.DataFrame, count: int = 10) -> pd.DataFrame:
    agencies = frame["ISSUING_AGENCY_SHORT"].value_counts().head(count).index
    monthly = (
        frame.loc[frame["ISSUING_AGENCY_SHORT"].isin(agencies)]
        .groupby(["YEAR_MONTH", "ISSUING_AGENCY_SHORT"])
        .size()
        .unstack(fill_value=0)
        .sort_index()
    )
    means = monthly.mean().replace(0, np.nan)
    return monthly.divide(means, axis=1).mul(100)


def period_frames(
    frame: pd.DataFrame,
    cutoff: str,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    cutoff_date = pd.Timestamp(cutoff)
    return (
        frame.loc[frame["ISSUE_DATE"].lt(cutoff_date)].copy(),
        frame.loc[frame["ISSUE_DATE"].ge(cutoff_date)].copy(),
    )


def agency_change(
    frame: pd.DataFrame,
    cutoff: str,
    minimum_before_count: int = 500,
) -> pd.DataFrame:
    before, after = period_frames(frame, cutoff)
    before_months = max(before["YEAR_MONTH"].nunique(), 1)
    after_months = max(after["YEAR_MONTH"].nunique(), 1)

    result = pd.concat(
        [
            before.groupby("ISSUING_AGENCY_SHORT").size().rename("before_count"),
            after.groupby("ISSUING_AGENCY_SHORT").size().rename("after_count"),
        ],
        axis=1,
    ).fillna(0)
    result["before_monthly_rate"] = result["before_count"] / before_months
    result["after_monthly_rate"] = result["after_count"] / after_months
    denominator = result["before_monthly_rate"].replace(0, np.nan)
    result["monthly_rate_pct_change"] = (
        (result["after_monthly_rate"] - result["before_monthly_rate"])
        / denominator
        * 100
    )
    result = result.loc[result["before_count"].ge(minimum_before_count)]
    return (
        result.reset_index(names="agency")
        .sort_values("monthly_rate_pct_change")
        .reset_index(drop=True)
    )


def violation_share_shift(
    frame: pd.DataFrame,
    cutoff: str,
    count: int = 20,
) -> pd.DataFrame:
    before, after = period_frames(frame, cutoff)
    top_types = frame["VIOLATION_PROCESS_DESC"].value_counts().head(count).index
    before_share = (
        before["VIOLATION_PROCESS_DESC"]
        .value_counts(normalize=True)
        .mul(100)
        .reindex(top_types, fill_value=0)
    )
    after_share = (
        after["VIOLATION_PROCESS_DESC"]
        .value_counts(normalize=True)
        .mul(100)
        .reindex(top_types, fill_value=0)
    )
    return (
        pd.DataFrame(
            {
                "violation": top_types,
                "before_share_pct": before_share.values,
                "after_share_pct": after_share.values,
                "percentage_point_change": (after_share - before_share).values,
            }
        )
        .sort_values("percentage_point_change")
        .reset_index(drop=True)
    )


def hourly_share(frame: pd.DataFrame, cutoff: str) -> pd.DataFrame:
    before, after = period_frames(frame, cutoff)
    rows = []
    for label, selected in (("Before", before), ("After", after)):
        counts = selected["ISSUE_HOUR"].value_counts().reindex(range(24), fill_value=0)
        denominator = counts.sum()
        shares = counts.div(denominator).mul(100) if denominator else counts.astype(float)
        rows.extend(
            {"period": label, "hour": hour, "share_pct": float(shares.loc[hour])}
            for hour in range(24)
        )
    return pd.DataFrame(rows)


def quadrant_share(frame: pd.DataFrame, cutoff: str) -> pd.DataFrame:
    before, after = period_frames(frame, cutoff)
    rows = []
    for label, selected in (("Before", before), ("After", after)):
        quadrant = selected["LOCATION"].str.extract(
            r"\b(NW|NE|SW|SE)\b", expand=False
        )
        counts = quadrant.value_counts().reindex(["NW", "NE", "SW", "SE"], fill_value=0)
        denominator = counts.sum()
        shares = counts.div(denominator).mul(100) if denominator else counts.astype(float)
        rows.extend(
            {
                "period": label,
                "quadrant": name,
                "share_pct": float(shares.loc[name]),
            }
            for name in counts.index
        )
    return pd.DataFrame(rows)


def write_analysis_tables(
    frame: pd.DataFrame,
    output_dir: Path,
    *,
    cutoff: str,
    minimum_before_count: int,
) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    complete = exclude_incomplete_current_month(frame)

    tables = {
        "monthly_counts.csv": monthly_counts(complete),
        "monthly_counts_by_type.csv": monthly_counts_by_type(complete),
        "monthly_payments.csv": monthly_payments(complete),
        "top_agencies.csv": top_agencies(complete),
        "agency_change.csv": agency_change(
            complete, cutoff, minimum_before_count
        ),
        "violation_share_shift.csv": violation_share_shift(complete, cutoff),
        "hourly_share.csv": hourly_share(complete, cutoff),
        "quadrant_share.csv": quadrant_share(complete, cutoff),
    }
    for filename, table in tables.items():
        table.to_csv(output_dir / filename, index=False)

    metrics = headline_metrics(frame)
    with (output_dir / "headline_metrics.json").open("w", encoding="utf-8") as file:
        json.dump(metrics, file, indent=2)
    return metrics
