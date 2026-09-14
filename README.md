# BusViolations

A reproducible analysis of bus-related traffic violations in Washington, D.C.

This repository is being migrated from a Colab notebook. The initial commit establishes a clean project structure; the analysis code, source inventory, and reproducible workflow will be added in the next stage.

## Repository structure

| Path | Purpose |
| --- | --- |
| `data/raw/` | Original source files, kept out of Git |
| `data/interim/` | Cleaned or joined working data |
| `data/processed/` | Analysis-ready datasets |
| `notebooks/` | Exploratory notebooks and the archived Colab workflow |
| `src/` | Reusable analysis code |
| `config/` | Non-secret project settings |
| `outputs/figures/` | Generated charts and maps |
| `outputs/tables/` | Generated tables |
| `docs/` | Methods, decisions, and project notes |

## Data policy

Large or sensitive datasets should not be committed directly. Record every source in `data/README.md`, including its publisher, retrieval date, URL, coverage, and expected local filename.

## Current status

Repository scaffold created. The next step is to break the Colab notebook into a small, ordered pipeline while preserving a notebook for exploration.
