"""Command-line entry point for the D.C. violations pipeline."""

from __future__ import annotations

import argparse
import asyncio
from pathlib import Path

import pandas as pd

from .analysis import filter_records, write_analysis_tables
from .clean import clean_and_save
from .config import Settings
from .download import download_and_save
from .plots import make_all_plots


def _paths(settings: Settings) -> tuple[Path, Path]:
    return (
        settings.raw_dir / "dc_all_violations.parquet",
        settings.processed_dir / "dc_all_violations_clean.parquet",
    )


def run_clean(settings: Settings) -> pd.DataFrame:
    raw_path, processed_path = _paths(settings)
    if not raw_path.exists():
        raise FileNotFoundError(
            f"{raw_path} does not exist. Run the download stage first."
        )
    return clean_and_save(raw_path, processed_path)


def run_analysis(
    settings: Settings,
    *,
    agency: str | None = None,
    violation: str | None = None,
) -> None:
    _, processed_path = _paths(settings)
    if not processed_path.exists():
        raise FileNotFoundError(
            f"{processed_path} does not exist. Run the clean stage first."
        )

    frame = pd.read_parquet(processed_path)
    frame = filter_records(frame, agency=agency, violation=violation)
    if frame.empty:
        raise ValueError("The selected filters produced no records.")

    metrics = write_analysis_tables(
        frame,
        settings.output_dir / "tables",
        cutoff=settings.cutoff,
        minimum_before_count=settings.minimum_pre_cutoff_agency_count,
    )
    make_all_plots(
        frame,
        settings.output_dir / "figures",
        cutoff=settings.cutoff,
        minimum_before_count=settings.minimum_pre_cutoff_agency_count,
    )
    print(
        "Analysis complete: "
        f"{metrics['rows']:,} rows, "
        "$" + f"{metrics['fine_total']:,.0f} in fines, "
        "$" + f"{metrics['paid_total']:,.0f} paid"
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Download and analyze D.C. moving and parking violations."
    )
    parser.add_argument(
        "stage",
        choices=("download", "clean", "analyze", "all"),
        nargs="?",
        default="all",
    )
    parser.add_argument(
        "--agency",
        help="Optional literal match within ISSUING_AGENCY_SHORT.",
    )
    parser.add_argument(
        "--violation",
        help="Optional literal match within VIOLATION_PROCESS_DESC.",
    )
    return parser


def main() -> None:
    args = build_parser().parse_args()
    settings = Settings()

    if args.stage in ("download", "all"):
        asyncio.run(download_and_save(settings))
    if args.stage in ("clean", "all"):
        run_clean(settings)
    if args.stage in ("analyze", "all"):
        run_analysis(
            settings,
            agency=args.agency,
            violation=args.violation,
        )


if __name__ == "__main__":
    main()
