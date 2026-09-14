# Migration notes

The source was supplied as pasted Colab notebook text and was translated into importable Python modules. The notebook itself is not part of this repository.

## Cell-to-module map

| Notebook responsibility | Repository module |
| --- | --- |
| ArcGIS configuration and year/month settings | `src/bus_violations/config.py` |
| Async requests, retries, pagination, and Parquet export | `src/bus_violations/download.py` |
| Date, numeric, string, plate-state, and issue-time cleaning | `src/bus_violations/clean.py` |
| Monthly and August 2025 comparison tables | `src/bus_violations/analysis.py` |
| Ten descriptive charts | `src/bus_violations/plots.py` |
| Ordered execution and filters | `src/bus_violations/pipeline.py` |

## Translation decisions

- Consolidated the notebook's duplicated downloader into one implementation.
- Replaced Colab's top-level `await main()` with a normal command-line entry point using `asyncio.run`.
- Removed `google.colab.files.download`; artifacts now use stable project paths.
- Split raw acquisition from cleaning so the original downloaded attributes are retained.
- Added a per-layer download manifest.
- Changed page failures from warnings to fatal errors to prevent incomplete data from being treated as complete.
- Validated both the hour and minute portions of `ISSUE_TIME`.
- Excluded the incomplete current month from comparative time-series outputs.
- Replaced unequal-period total-count comparisons with average monthly rates.
- Preserved the notebook's August 1, 2025 cutoff and documented that it is descriptive rather than causal.
