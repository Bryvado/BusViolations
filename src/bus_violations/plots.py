"""Create the figures from the original Colab analysis."""

from __future__ import annotations

from pathlib import Path

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
import matplotlib.ticker as mticker
import pandas as pd

from .analysis import (
    agency_change,
    agency_monthly_index,
    exclude_incomplete_current_month,
    hourly_share,
    monthly_counts,
    monthly_counts_by_type,
    monthly_payments,
    quadrant_share,
    top_agencies,
    violation_share_shift,
)


def _finish(fig: plt.Figure, path: Path) -> None:
    fig.tight_layout()
    fig.savefig(path, dpi=200, bbox_inches="tight")
    plt.close(fig)


def _month_ticks(ax: plt.Axes, labels: list[str]) -> None:
    step = max(1, len(labels) // 12)
    positions = list(range(0, len(labels), step))
    ax.set_xticks(positions)
    ax.set_xticklabels(
        [labels[position] for position in positions],
        rotation=45,
        ha="right",
    )


def make_all_plots(
    frame: pd.DataFrame,
    output_dir: Path,
    *,
    cutoff: str,
    minimum_before_count: int,
) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    complete = exclude_incomplete_current_month(frame)
    cutoff_label = pd.Timestamp(cutoff).strftime("%b %Y")

    monthly = monthly_counts(complete)
    fig, ax = plt.subplots(figsize=(14, 5))
    ax.plot(
        range(len(monthly)),
        monthly["violation_count"],
        color="steelblue",
        linewidth=2,
        marker="o",
        markersize=3,
    )
    ax.set_title("Violations Over Time (Monthly)", fontweight="bold")
    ax.set_xlabel("Month")
    ax.set_ylabel("Number of violations")
    _month_ticks(ax, monthly["YEAR_MONTH"].tolist())
    ax.yaxis.set_major_formatter(mticker.StrMethodFormatter("{x:,.0f}"))
    ax.grid(axis="y", linestyle="--", alpha=0.5)
    _finish(fig, output_dir / "01_violations_over_time.png")

    typed = monthly_counts_by_type(complete).pivot(
        index="YEAR_MONTH",
        columns="source_violation_type",
        values="violation_count",
    ).fillna(0)
    fig, ax = plt.subplots(figsize=(14, 5))
    typed.plot(ax=ax, linewidth=2, marker="o", markersize=3)
    ax.set_title("Violations Over Time: Moving vs. Parking", fontweight="bold")
    ax.set_xlabel("Month")
    ax.set_ylabel("Number of violations")
    _month_ticks(ax, typed.index.tolist())
    ax.yaxis.set_major_formatter(mticker.StrMethodFormatter("{x:,.0f}"))
    ax.grid(axis="y", linestyle="--", alpha=0.5)
    ax.legend(title="Violation type")
    _finish(fig, output_dir / "02_moving_vs_parking.png")

    fig, ax = plt.subplots(figsize=(10, 5))
    complete["FINE_AMOUNT"].clip(upper=500).hist(
        bins=40,
        color="steelblue",
        edgecolor="white",
        ax=ax,
    )
    ax.set_title("Distribution of Fine Amounts (Capped at $500)", fontweight="bold")
    ax.set_xlabel("Fine amount")
    ax.set_ylabel("Number of violations")
    ax.xaxis.set_major_formatter(mticker.StrMethodFormatter("$"+"{x:,.0f}"))
    ax.yaxis.set_major_formatter(mticker.StrMethodFormatter("{x:,.0f}"))
    ax.grid(axis="y", linestyle="--", alpha=0.5)
    _finish(fig, output_dir / "03_fine_distribution.png")

    payment = monthly_payments(complete).set_index("YEAR_MONTH")
    fig, ax = plt.subplots(figsize=(14, 5))
    payment.plot(ax=ax, linewidth=2)
    ax.set_title("Total Fines Issued vs. Total Paid (Monthly)", fontweight="bold")
    ax.set_xlabel("Month")
    ax.set_ylabel("Amount")
    _month_ticks(ax, payment.index.tolist())
    ax.yaxis.set_major_formatter(
        mticker.FuncFormatter(lambda value, _: "$" + f"{value / 1_000_000:.1f}M")
    )
    ax.grid(axis="y", linestyle="--", alpha=0.5)
    ax.legend(["Fines issued", "Total paid"])
    _finish(fig, output_dir / "04_fines_issued_vs_paid.png")

    agencies = top_agencies(complete).sort_values("violation_count")
    fig, ax = plt.subplots(figsize=(10, 5))
    ax.barh(agencies["agency"], agencies["violation_count"], color="steelblue")
    ax.set_title("Top 10 Issuing Agencies", fontweight="bold")
    ax.set_xlabel("Number of violations (log scale)")
    ax.set_xscale("log")
    ax.xaxis.set_major_formatter(mticker.StrMethodFormatter("{x:,.0f}"))
    ax.grid(axis="x", linestyle="--", alpha=0.5)
    _finish(fig, output_dir / "05_top_agencies.png")

    normalized = agency_monthly_index(complete)
    fig, ax = plt.subplots(figsize=(14, 6))
    normalized.plot(ax=ax, linewidth=1.5, marker="o", markersize=2)
    labels = normalized.index.tolist()
    if cutoff[:7] in labels:
        ax.axvline(labels.index(cutoff[:7]), color="red", linestyle="--", label=cutoff_label)
    ax.set_title(
        "Top Agencies: Normalized Activity Over Time\n"
        "(100 = each agency's monthly average)",
        fontweight="bold",
    )
    ax.set_xlabel("Month")
    ax.set_ylabel("Percent of agency mean")
    _month_ticks(ax, labels)
    ax.legend(fontsize=8, ncol=2)
    ax.grid(axis="y", linestyle="--", alpha=0.5)
    _finish(fig, output_dir / "06_agency_normalized_activity.png")

    changes = agency_change(complete, cutoff, minimum_before_count)
    fig, ax = plt.subplots(figsize=(12, 8))
    colors = [
        "darkorange" if value > 0 else "steelblue"
        for value in changes["monthly_rate_pct_change"]
    ]
    ax.barh(changes["agency"], changes["monthly_rate_pct_change"], color=colors)
    ax.axvline(0, color="black", linewidth=0.8)
    ax.set_title(
        f"Change in Monthly Violation Rate by Agency After {cutoff_label}",
        fontweight="bold",
    )
    ax.set_xlabel("Change in average monthly violations")
    ax.xaxis.set_major_formatter(mticker.PercentFormatter())
    ax.grid(axis="x", linestyle="--", alpha=0.5)
    _finish(fig, output_dir / "07_agency_change.png")

    shift = violation_share_shift(complete, cutoff)
    fig, ax = plt.subplots(figsize=(12, 7))
    colors = [
        "darkorange" if value > 0 else "steelblue"
        for value in shift["percentage_point_change"]
    ]
    ax.barh(
        shift["violation"],
        shift["percentage_point_change"],
        color=colors,
    )
    ax.axvline(0, color="black", linewidth=0.8)
    ax.set_title(
        f"Shift in Violation-Type Share After {cutoff_label}",
        fontweight="bold",
    )
    ax.set_xlabel("Percentage-point change")
    ax.grid(axis="x", linestyle="--", alpha=0.5)
    _finish(fig, output_dir / "08_violation_share_shift.png")

    hourly = hourly_share(complete, cutoff)
    fig, ax = plt.subplots(figsize=(14, 5))
    for label, color in (("Before", "steelblue"), ("After", "darkorange")):
        selected = hourly.loc[hourly["period"].eq(label)]
        ax.plot(
            selected["hour"],
            selected["share_pct"],
            label=f"{label} {cutoff_label}",
            color=color,
            linewidth=2,
            marker="o",
            markersize=4,
        )
    ax.set_title("Time-of-Day Distribution Before vs. After", fontweight="bold")
    ax.set_xlabel("Hour of day")
    ax.set_ylabel("Share of violations")
    ax.set_xticks(range(24))
    ax.set_xticklabels(
        [f"{hour:02d}:00" for hour in range(24)],
        rotation=45,
        ha="right",
        fontsize=8,
    )
    ax.yaxis.set_major_formatter(mticker.PercentFormatter())
    ax.legend()
    ax.grid(axis="y", linestyle="--", alpha=0.5)
    _finish(fig, output_dir / "09_time_of_day_shift.png")

    quadrants = quadrant_share(complete, cutoff)
    pivot = quadrants.pivot(
        index="quadrant",
        columns="period",
        values="share_pct",
    ).reindex(["NW", "NE", "SW", "SE"])
    fig, axes = plt.subplots(1, 2, figsize=(14, 5), sharey=True)
    colors = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2"]
    for ax, period in zip(axes, ("Before", "After")):
        ax.bar(pivot.index, pivot[period], color=colors)
        ax.set_title(f"{period} {cutoff_label}", fontweight="bold")
        ax.set_xlabel("Quadrant")
        ax.yaxis.set_major_formatter(mticker.PercentFormatter())
        ax.grid(axis="y", linestyle="--", alpha=0.5)
    axes[0].set_ylabel("Share of violations")
    fig.suptitle("Geographic Distribution Before vs. After", fontweight="bold")
    _finish(fig, output_dir / "10_quadrant_shift.png")
