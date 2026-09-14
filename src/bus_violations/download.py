"""Download monthly violation layers from the DCGIS ArcGIS service."""

from __future__ import annotations

import asyncio
import json
import random
import time
from typing import Any

import aiohttp
import pandas as pd

from .config import MONTHS, Settings


class LayerNotAvailable(Exception):
    """A requested monthly layer does not exist or cannot be queried."""


def _is_nonretryable(error_body: dict[str, Any]) -> bool:
    code = error_body.get("code", 0)
    message = str(error_body.get("message", "")).lower()
    phrases = (
        "error performing query",
        "layer not found",
        "invalid or missing input",
        "unable to complete",
    )
    return code in (400, 500) and any(phrase in message for phrase in phrases)


async def arcgis_get(
    session: aiohttp.ClientSession,
    semaphore: asyncio.Semaphore,
    url: str,
    params: dict[str, Any],
    settings: Settings,
) -> dict[str, Any]:
    last_error: Exception | None = None

    for attempt in range(settings.max_retries):
        try:
            async with semaphore:
                async with session.get(
                    url,
                    params=params,
                    timeout=aiohttp.ClientTimeout(total=settings.request_timeout),
                ) as response:
                    if response.status == 404:
                        raise LayerNotAvailable(f"HTTP 404 for {url}")

                    body = await response.text()
                    if not body.strip():
                        raise RuntimeError(
                            f"Empty response from DCGIS (HTTP {response.status})"
                        )
                    try:
                        data = json.loads(body)
                    except json.JSONDecodeError as error:
                        content_type = response.headers.get("Content-Type", "unknown")
                        raise RuntimeError(
                            "Non-JSON response from DCGIS "
                            f"(HTTP {response.status}; {content_type})"
                        ) from error

                    if "error" in data and _is_nonretryable(data["error"]):
                        raise LayerNotAvailable(str(data["error"]))

                    response.raise_for_status()
                    if "error" in data:
                        raise RuntimeError(data["error"])
                    return data
        except LayerNotAvailable:
            raise
        except Exception as error:
            last_error = error
            if attempt + 1 == settings.max_retries:
                break
            base_wait = min(settings.initial_backoff * (2**attempt), 30)
            wait = base_wait + random.uniform(0.5, min(base_wait, 5.0))
            print(
                f"  retry {attempt + 1}/{settings.max_retries} "
                f"({error!r}); sleeping {wait:.1f}s"
            )
            await asyncio.sleep(wait)

    if last_error is None:
        raise RuntimeError(f"Request failed without an error: {url}")
    raise last_error


async def fetch_layer_count(
    session: aiohttp.ClientSession,
    semaphore: asyncio.Semaphore,
    query_url: str,
    settings: Settings,
) -> int:
    data = await arcgis_get(
        session,
        semaphore,
        query_url,
        {"f": "json", "where": "1=1", "returnCountOnly": "true"},
        settings,
    )
    return int(data["count"])


async def fetch_layer_page(
    session: aiohttp.ClientSession,
    semaphore: asyncio.Semaphore,
    query_url: str,
    offset: int,
    settings: Settings,
) -> list[dict[str, Any]]:
    data = await arcgis_get(
        session,
        semaphore,
        query_url,
        {
            "f": "json",
            "where": "1=1",
            "outFields": "*",
            "returnGeometry": "false",
            "orderByFields": "OBJECTID ASC",
            "resultOffset": offset,
            "resultRecordCount": settings.page_size,
        },
        settings,
    )
    return [feature.get("attributes", {}) for feature in data.get("features", [])]


async def fetch_one_layer(
    session: aiohttp.ClientSession,
    semaphore: asyncio.Semaphore,
    violation_type: str,
    year: int,
    layer_id: int,
    settings: Settings,
) -> tuple[pd.DataFrame, dict[str, Any]]:
    month = MONTHS[layer_id]
    service_url = settings.service_url_template.format(
        viol_type=violation_type,
        year=year,
    )
    query_url = f"{service_url}/{layer_id}/query"
    record = {
        "violation_type": violation_type,
        "year": year,
        "month": month,
        "layer_id": layer_id,
    }

    try:
        total = await fetch_layer_count(session, semaphore, query_url, settings)
    except LayerNotAvailable as error:
        print(f"  {violation_type} {month} {year}: unavailable; skipped")
        return pd.DataFrame(), {
            **record,
            "status": "unavailable",
            "expected_rows": 0,
            "downloaded_rows": 0,
            "message": str(error),
        }

    if total == 0:
        print(f"  {violation_type} {month} {year}: 0 rows")
        return pd.DataFrame(), {
            **record,
            "status": "empty",
            "expected_rows": 0,
            "downloaded_rows": 0,
            "message": "",
        }

    offsets = range(0, total, settings.page_size)
    pages = await asyncio.gather(
        *[
            fetch_layer_page(session, semaphore, query_url, offset, settings)
            for offset in offsets
        ],
        return_exceptions=True,
    )
    errors = [page for page in pages if isinstance(page, BaseException)]
    if errors:
        raise RuntimeError(
            f"{violation_type} {month} {year}: "
            f"{len(errors)} page request(s) failed; refusing a partial layer"
        ) from errors[0]

    rows = [row for page in pages for row in page]
    if len(rows) != total:
        raise RuntimeError(
            f"{violation_type} {month} {year}: expected {total:,} rows "
            f"but received {len(rows):,}"
        )

    frame = pd.DataFrame(rows)
    frame["source_violation_type"] = violation_type
    frame["source_year"] = year
    frame["source_month"] = month
    frame["source_month_num"] = layer_id + 1
    print(f"  {violation_type} {month} {year}: {len(frame):,} rows")

    return frame, {
        **record,
        "status": "downloaded",
        "expected_rows": total,
        "downloaded_rows": len(frame),
        "message": "",
    }


async def fetch_all(
    settings: Settings | None = None,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    settings = settings or Settings()
    semaphore = asyncio.Semaphore(settings.concurrent_requests)
    connector = aiohttp.TCPConnector(
        limit=settings.concurrent_requests,
        limit_per_host=settings.per_host_limit,
    )

    async with aiohttp.ClientSession(connector=connector) as session:
        tasks = [
            fetch_one_layer(
                session,
                semaphore,
                violation_type,
                year,
                layer_id,
                settings,
            )
            for violation_type in settings.violation_types
            for year in settings.years
            for layer_id in MONTHS
        ]
        print(f"Launching {len(tasks)} monthly layer downloads...")
        started = time.perf_counter()
        results = await asyncio.gather(*tasks, return_exceptions=True)
        print(f"Downloads finished in {time.perf_counter() - started:.1f}s")

    failures = [result for result in results if isinstance(result, BaseException)]
    if failures:
        messages = "\n".join(f"- {error}" for error in failures)
        raise RuntimeError(
            "One or more layers failed. No combined file was written:\n" + messages
        )

    frames = [result[0] for result in results if not result[0].empty]
    manifest = pd.DataFrame([result[1] for result in results])
    if not frames:
        raise RuntimeError("No records were downloaded.")

    return pd.concat(frames, ignore_index=True), manifest


async def download_and_save(settings: Settings | None = None) -> pd.DataFrame:
    settings = settings or Settings()
    settings.raw_dir.mkdir(parents=True, exist_ok=True)
    frame, manifest = await fetch_all(settings)

    for violation_type in settings.violation_types:
        subset = frame.loc[
            frame["source_violation_type"].eq(violation_type)
        ].copy()
        path = settings.raw_dir / f"dc_{violation_type.lower()}_violations.parquet"
        subset.to_parquet(path, index=False)
        print(f"Wrote {len(subset):,} rows to {path}")

    combined_path = settings.raw_dir / "dc_all_violations.parquet"
    manifest_path = settings.raw_dir / "download_manifest.csv"
    frame.to_parquet(combined_path, index=False)
    manifest.to_csv(manifest_path, index=False)
    print(f"Wrote {len(frame):,} rows to {combined_path}")
    print(f"Wrote download audit to {manifest_path}")
    return frame
