# Project notes

## Working description

This project analyzes bus-related traffic violations in Washington, D.C. The exact unit of analysis, source agencies, date coverage, and intended publication outputs will be documented while the Colab notebook is migrated.

## Migration checklist

- [ ] Add the original Colab notebook to `notebooks/`.
- [ ] Inventory every input file, URL, and manually entered value.
- [ ] Record data sources in `data/README.md`.
- [ ] Identify the notebook's language and dependencies.
- [ ] Separate reusable logic from exploratory cells.
- [ ] Add explicit validation checks for row counts, identifiers, dates, and geography.
- [ ] Reproduce the notebook's current headline results.
- [ ] Add a single documented command for rebuilding the project.
- [ ] Record methodological choices and known limitations.
- [ ] Remove secrets, temporary downloads, and embedded large outputs before committing.

## Decisions

| Date | Decision | Reason |
| --- | --- | --- |
| 2026-09-14 | Keep raw and intermediate data out of Git by default. | Prevent accidental publication and keep the repository lightweight. |
| 2026-09-14 | Delay choosing a language-specific framework until the notebook is inventoried. | Avoid imposing the wrong tooling during migration. |
