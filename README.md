# BusViolations

A reproducible Python pipeline for downloading and analyzing moving and parking violations published through the District of Columbia's ArcGIS services.

The code is translated from an exploratory Colab notebook. The notebook itself is intentionally not stored here.

## What the pipeline does

1. Downloads monthly moving and parking violation layers for 2024–2026.
2. Audits every requested layer and refuses to write a combined dataset if a page fails.
3. Cleans dates, money fields, text fields, plate states, and issue times.
4. Removes unusable records, nonpositive fines, and future issue dates.
5. Produces monthly, agency, violation-type, time-of-day, and quadrant analyses.
6. Compares periods before and after August 1, 2025.
7. Saves reproducible CSV tables and PNG figures.

## Set up

Python 3.10 or newer is required.

```bash
git clone https://github.com/Bryvado/BusViolations.git
cd BusViolations
python -m venv .venv
```

Activate the environment:

```bash
# macOS or Linux
source .venv/bin/activate

# Windows PowerShell
.venv\Scripts\Activate.ps1
```

Install the project:

```bash
python -m pip install --upgrade pip
python -m pip install -e .
```

## Run

Run the full pipeline:

```bash
bus-violations all
```

Or run one stage at a time:

```bash
bus-violations download
bus-violations clean
bus-violations analyze
```

Optional analysis filters perform literal, case-insensitive matching:

```bash
bus-violations analyze --agency MPD
bus-violations analyze --violation SPEED
```

## Outputs

| Path | Contents |
| --- | --- |
| `data/raw/dc_all_violations.parquet` | Combined DCGIS download |
| `data/raw/download_manifest.csv` | Expected and downloaded rows by monthly layer |
| `data/processed/dc_all_violations_clean.parquet` | Analysis-ready records |
| `outputs/tables/` | Summary and before/after CSV files |
| `outputs/figures/` | Ten charts translated from the notebook |

Datasets are excluded from Git. Generated figures and tables may be committed selectively when they are ready for review or publication.

## Tests

```bash
python -m pip install -e ".[dev]"
pytest
```

See `docs/methodology.md` for assumptions and interpretation cautions.
