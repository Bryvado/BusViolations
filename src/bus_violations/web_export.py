"""Build exact, browser-ready Parquet files for the GitHub Pages dashboard."""

from __future__ import annotations

import argparse
import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import aiohttp
import pandas as pd

from .clean import clean_violations
from .config import MONTHS, Settings
from .download import fetch_one_layer

POINT_COLUMNS = {
    "LATITUDE": "latitude",
    "LONGITUDE": "longitude",
    "ISSUE_DATE": "issue_date",
    "ISSUE_HOUR": "issue_hour",
    "ISSUING_AGENCY_SHORT": "agency",
    "VIOLATION_PROCESS_DESC": "violation",
    "PLATE_STATE": "plate_state",
    "FINE_AMOUNT": "fine_amount",
    "TOTAL_PAID": "total_paid",
    "LOCATION": "location",
    "source_violation_type": "violation_type",
    "source_year": "year",
    "source_month_num": "month",
}
SUMMARY_KEYS = (
    "issue_date",
    "year_month",
    "violation_type",
    "agency",
    "violation",
    "plate_state",
    "fine_amount",
)


def _dashboard_rows(frame: pd.DataFrame) -> pd.DataFrame:
    selected = frame.loc[:, list(POINT_COLUMNS)].rename(columns=POINT_COLUMNS).copy()
    selected["total_paid"] = selected["total_paid"].fillna(0)
    return selected


def _valid_dc_coordinates(frame: pd.DataFrame) -> pd.Series:
    return (
        frame["latitude"].between(38.75, 39.05)
        & frame["longitude"].between(-77.20, -76.85)
    )


def _summarize(frame: pd.DataFrame) -> pd.DataFrame:
    working = frame.copy()
    working["issue_date"] = working["issue_date"].dt.floor("D")
    working["year_month"] = working["issue_date"].dt.to_period("M").astype("string")
    return (
        working.groupby(list(SUMMARY_KEYS), dropna=False, observed=True)
        .agg(
            violation_count=("fine_amount", "size"),
            fine_total=("fine_amount", "sum"),
            paid_total=("total_paid", "sum"),
        )
        .reset_index()
    )


async def build_web_data(
    output_dir: Path,
    settings: Settings | None = None,
    *,
    batch_size: int = 4,
) -> dict[str, Any]:
    settings = settings or Settings()
    output_dir.mkdir(parents=True, exist_ok=True)
    points_dir = output_dir / "points"
    points_dir.mkdir(parents=True, exist_ok=True)

    specs = [
        (violation_type, year, layer_id)
        for year in settings.years
        for layer_id in MONTHS
        for violation_type in settings.violation_types
    ]
    partitions: list[dict[str, Any]] = []
    summaries: list[pd.DataFrame] = []
    semaphore = asyncio.Semaphore(settings.concurrent_requests)
    connector = aiohttp.TCPConnector(
        limit=settings.concurrent_requests,
        limit_per_host=settings.per_host_limit,
    )

    async with aiohttp.ClientSession(connector=connector) as session:
        for start in range(0, len(specs), batch_size):
            batch = specs[start : start + batch_size]
            results = await asyncio.gather(
                *[
                    fetch_one_layer(
                        session,
                        semaphore,
                        violation_type,
                        year,
                        layer_id,
                        settings,
                    )
                    for violation_type, year, layer_id in batch
                ]
            )

            for (violation_type, year, layer_id), (raw, audit) in zip(batch, results):
                month = layer_id + 1
                entry: dict[str, Any] = {
                    "year": year,
                    "month": month,
                    "month_name": MONTHS[layer_id],
                    "violation_type": violation_type,
                    "status": audit["status"],
                    "source_rows": int(audit["downloaded_rows"]),
                    "analysis_rows": 0,
                    "coordinate_rows": 0,
                    "path": None,
                }

                if raw.empty:
                    partitions.append(entry)
                    continue

                clean = clean_violations(raw)
                dashboard = _dashboard_rows(clean)
                summaries.append(_summarize(dashboard))

                mapped = dashboard.loc[_valid_dc_coordinates(dashboard)].copy()
                relative_path = (
                    Path("points")
                    / str(year)
                    / f"{month:02d}-{violation_type.lower()}.parquet"
                )
                destination = output_dir / relative_path
                destination.parent.mkdir(parents=True, exist_ok=True)
                mapped.to_parquet(
                    destination,
                    index=False,
                    compression="zstd",
                    engine="pyarrow",
                )

                entry.update(
                    {
                        "status": "ready",
                        "analysis_rows": int(len(dashboard)),
                        "coordinate_rows": int(len(mapped)),
                        "path": relative_path.as_posix(),
                        "bytes": destination.stat().st_size,
                    }
                )
                partitions.append(entry)
                print(
                    f"Web partition {year}-{month:02d} {violation_type}: "
                    f"{len(mapped):,} mapped / {len(dashboard):,} analysis rows"
                )

    if not summaries:
        raise RuntimeError("No web data was produced.")

    trend_summary = pd.concat(summaries, ignore_index=True)
    trend_path = output_dir / "trend_summary.parquet"
    trend_summary.to_parquet(
        trend_path,
        index=False,
        compression="zstd",
        engine="pyarrow",
    )

    manifest = {
        "schema_version": 2,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "no_sampling": True,
        "summary_granularity": "day",
        "trend_summary": "trend_summary.parquet",
        "partitions": partitions,
    }
    manifest_path = output_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    total_bytes = sum(
        path.stat().st_size for path in output_dir.rglob("*") if path.is_file()
    )
    print(f"Web data size: {total_bytes / 1_000_000:.1f} MB")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build complete Parquet partitions for the web dashboard."
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("_site/data"),
        help="Destination data directory.",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=4,
        help="Monthly layers held in memory at once.",
    )
    args = parser.parse_args()
    asyncio.run(build_web_data(args.output, batch_size=args.batch_size))


if __name__ == "__main__":
    main()
