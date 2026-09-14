"""Clean and validate downloaded DCGIS violation records."""

from __future__ import annotations

from pathlib import Path

import pandas as pd

COLUMN_ALIASES = {
    "VIOLATION_PROC_DESC": "VIOLATION_PROCESS_DESC",
}
DATETIME_COLUMNS = ("ISSUE_DATE", "GIS_LAST_MOD_DTTM", "DISPOSITION_DATE")
NUMERIC_COLUMNS = (
    "FINE_AMOUNT",
    "TOTAL_PAID",
    "PENALTY_1",
    "PENALTY_2",
    "PENALTY_3",
    "PENALTY_4",
    "PENALTY_5",
    "LATITUDE",
    "LONGITUDE",
    "ISSUING_AGENCY_CODE",
)
STRING_COLUMNS = (
    "LOCATION",
    "ISSUING_AGENCY_NAME",
    "ISSUING_AGENCY_SHORT",
    "VIOLATION_CODE",
    "VIOLATION_PROCESS_DESC",
    "PLATE_STATE",
    "ACCIDENT_INDICATOR",
    "DISPOSITION_CODE",
    "DISPOSITION_TYPE",
)
CRITICAL_COLUMNS = (
    "ISSUE_DATE",
    "FINE_AMOUNT",
    "VIOLATION_PROCESS_DESC",
    "ISSUING_AGENCY_SHORT",
)


def _parse_arcgis_datetime(series: pd.Series) -> pd.Series:
    if pd.api.types.is_datetime64_any_dtype(series):
        return pd.to_datetime(series, errors="coerce")

    numeric = pd.to_numeric(series, errors="coerce")
    parsed_numeric = pd.to_datetime(numeric, unit="ms", errors="coerce")
    parsed_text = pd.to_datetime(series, errors="coerce")
    return parsed_numeric.where(numeric.notna(), parsed_text)


def _standardize_columns(frame: pd.DataFrame) -> pd.DataFrame:
    renames = {
        source: target
        for source, target in COLUMN_ALIASES.items()
        if source in frame.columns and target not in frame.columns
    }
    return frame.rename(columns=renames).copy()


def clean_violations(
    frame: pd.DataFrame,
    *,
    today: pd.Timestamp | None = None,
) -> pd.DataFrame:
    clean = _standardize_columns(frame)
    missing = sorted(set(CRITICAL_COLUMNS) - set(clean.columns))
    if missing:
        raise ValueError(f"Missing required columns: {', '.join(missing)}")

    for column in DATETIME_COLUMNS:
        if column in clean:
            clean[column] = _parse_arcgis_datetime(clean[column])

    for column in NUMERIC_COLUMNS:
        if column in clean:
            clean[column] = pd.to_numeric(clean[column], errors="coerce")

    for column in STRING_COLUMNS:
        if column in clean:
            clean[column] = clean[column].astype("string").str.strip()

    if "PLATE_STATE" in clean:
        clean["PLATE_STATE"] = clean["PLATE_STATE"].str.upper()
        clean["PLATE_STATE"] = clean["PLATE_STATE"].replace(
            {"": pd.NA, "NAN": pd.NA, "<NA>": pd.NA}
        ).fillna("UNKNOWN")

    if "ISSUE_TIME" in clean:
        issue_time = pd.to_numeric(clean["ISSUE_TIME"], errors="coerce")
        hour = issue_time.floordiv(100)
        minute = issue_time.mod(100)
        valid = issue_time.notna() & hour.between(0, 23) & minute.between(0, 59)
        clean["ISSUE_HOUR"] = hour.where(valid).astype("Int16")
        clean["ISSUE_MINUTE"] = minute.where(valid).astype("Int16")
        clean["ISSUE_TIME_HHMM"] = (
            hour.where(valid).astype("Int16").astype("string").str.zfill(2)
            + ":"
            + minute.where(valid).astype("Int16").astype("string").str.zfill(2)
        )

    before = len(clean)
    clean = clean.dropna(subset=list(CRITICAL_COLUMNS))
    clean = clean.loc[clean["FINE_AMOUNT"].gt(0)].copy()

    today = (today or pd.Timestamp.today()).normalize()
    clean = clean.loc[clean["ISSUE_DATE"].le(today)].copy()

    clean["YEAR_MONTH"] = clean["ISSUE_DATE"].dt.to_period("M").astype("string")
    paid = clean.get("TOTAL_PAID", pd.Series(0, index=clean.index)).fillna(0)
    clean["UNPAID"] = clean["FINE_AMOUNT"] - paid

    clean.attrs["rows_removed"] = before - len(clean)
    return clean.reset_index(drop=True)


def clean_and_save(
    input_path: Path,
    output_path: Path,
    *,
    today: pd.Timestamp | None = None,
) -> pd.DataFrame:
    frame = pd.read_parquet(input_path)
    clean = clean_violations(frame, today=today)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    clean.to_parquet(output_path, index=False)
    print(
        f"Wrote {len(clean):,} cleaned rows to {output_path} "
        f"({clean.attrs.get('rows_removed', 0):,} rows removed)"
    )
    return clean
