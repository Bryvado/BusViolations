import pandas as pd

from bus_violations.clean import clean_violations


def test_clean_violations_filters_and_derives_fields():
    frame = pd.DataFrame(
        {
            "ISSUE_DATE": [
                1_704_067_200_000,
                1_704_153_600_000,
                4_102_444_800_000,
            ],
            "FINE_AMOUNT": [100, 0, 50],
            "TOTAL_PAID": [25, 0, 0],
            "VIOLATION_PROCESS_DESC": [" Speed ", "Parking", "Moving"],
            "ISSUING_AGENCY_SHORT": [" MPD ", "DPW", "MPD"],
            "PLATE_STATE": [" dc ", None, "VA"],
            "ISSUE_TIME": [930, 1260, 800],
        }
    )

    result = clean_violations(
        frame,
        today=pd.Timestamp("2026-01-01"),
    )

    assert len(result) == 1
    assert result.loc[0, "VIOLATION_PROCESS_DESC"] == "Speed"
    assert result.loc[0, "ISSUING_AGENCY_SHORT"] == "MPD"
    assert result.loc[0, "PLATE_STATE"] == "DC"
    assert result.loc[0, "ISSUE_HOUR"] == 9
    assert result.loc[0, "ISSUE_MINUTE"] == 30
    assert result.loc[0, "ISSUE_TIME_HHMM"] == "09:30"
    assert result.loc[0, "YEAR_MONTH"] == "2024-01"
    assert result.loc[0, "UNPAID"] == 75


def test_invalid_issue_time_becomes_missing():
    frame = pd.DataFrame(
        {
            "ISSUE_DATE": [1_704_067_200_000],
            "FINE_AMOUNT": [100],
            "TOTAL_PAID": [0],
            "VIOLATION_PROCESS_DESC": ["Speed"],
            "ISSUING_AGENCY_SHORT": ["MPD"],
            "LOCATION": ["100 BLOCK H ST NW"],
            "ISSUE_TIME": [1260],
        }
    )

    result = clean_violations(
        frame,
        today=pd.Timestamp("2026-01-01"),
    )

    assert pd.isna(result.loc[0, "ISSUE_HOUR"])
    assert pd.isna(result.loc[0, "ISSUE_MINUTE"])
