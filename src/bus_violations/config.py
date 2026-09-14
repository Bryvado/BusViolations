"""Project configuration."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
MONTHS = {
    0: "January",
    1: "February",
    2: "March",
    3: "April",
    4: "May",
    5: "June",
    6: "July",
    7: "August",
    8: "September",
    9: "October",
    10: "November",
    11: "December",
}


@dataclass(frozen=True)
class Settings:
    years: tuple[int, ...] = (2024, 2025, 2026)
    violation_types: tuple[str, ...] = ("Moving", "Parking")
    service_url_template: str = (
        "https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/"
        "Violations_{viol_type}_{year}/MapServer"
    )
    page_size: int = 2_000
    max_retries: int = 8
    initial_backoff: float = 1.0
    concurrent_requests: int = 4
    per_host_limit: int = 2
    request_timeout: int = 120
    cutoff: str = "2025-08-01"
    minimum_pre_cutoff_agency_count: int = 500
    data_dir: Path = Path(
        os.environ.get("BUS_VIOLATIONS_DATA_DIR", PROJECT_ROOT / "data")
    )

    @property
    def raw_dir(self) -> Path:
        return self.data_dir / "raw"

    @property
    def processed_dir(self) -> Path:
        return self.data_dir / "processed"

    @property
    def output_dir(self) -> Path:
        return PROJECT_ROOT / "outputs"
