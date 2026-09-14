# Methodology

## Scope

The source notebook downloads D.C. moving and parking violation records for 2024, 2025, and 2026. Each annual ArcGIS service is expected to contain one layer per month.

## Acquisition safeguards

The downloader requests a layer count before requesting pages. A layer may be marked unavailable when it does not exist or returns a recognized permanent ArcGIS query error. Transient errors are retried with exponential backoff.

If any page fails, or the number of downloaded records does not match the advertised count, the layer fails and the combined dataset is not written. The download manifest records the status and row totals of every requested month.

## Cleaning

The cleaning stage:

- parses ArcGIS millisecond timestamps;
- converts fine, payment, penalty, and coordinate fields to numeric values;
- trims selected text fields;
- standardizes plate states and labels missing states as `UNKNOWN`;
- accepts an issue time only when its hour is 0–23 and minute is 0–59;
- removes records missing the issue date, fine amount, violation description, or issuing agency;
- removes nonpositive fines and future issue dates;
- derives year-month, issue hour, issue minute, and the notebook's `UNPAID` measure.

`UNPAID` is calculated as `FINE_AMOUNT - TOTAL_PAID`, matching the notebook. It should not automatically be described as the legal outstanding balance because payments may include penalties or other amounts.

## Time-series treatment

The current calendar month is excluded from monthly comparisons because it is incomplete. The August 1, 2025 cutoff from the notebook is retained.

The original notebook compared total counts before and after the cutoff even though the periods contain different numbers of months. The repository instead compares average monthly agency counts. This prevents period length alone from creating an apparent increase or decrease.

The cutoff is descriptive, not causal. A change after August 2025 does not establish that an event or policy in that month caused the change.

## Geography

Quadrants are inferred from an `NW`, `NE`, `SW`, or `SE` token in the text location field. Records without a recognized token are omitted from the quadrant shares. This is a text classification, not a spatial join.

## Reproducibility limits

The ArcGIS services can be revised after publication. The download manifest and retrieval-time outputs should be retained with any published analysis. Headline findings should be rerun and checked against the saved source extract before publication.
