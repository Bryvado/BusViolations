# Notebooks

Use notebooks for exploration, diagnostics, and presentation—not as the only copy of reusable analysis logic.

Suggested order:

1. `00_colab_archive.ipynb` — the original notebook preserved during migration.
2. `01_data_audit.ipynb` — source fields, coverage, and missingness.
3. `02_exploration.ipynb` — exploratory analysis and visual checks.

Move stable functions into `src/` as the project develops. Avoid committing notebook outputs that contain large tables, embedded data, or sensitive information.
