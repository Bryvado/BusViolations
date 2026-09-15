import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/+esm";

const DATA_ROOT = new URL("data/", window.location.href);
const DAY_MS = 86_400_000;
const NUMBER = new Intl.NumberFormat("en-US");
const MONEY = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const PERCENT = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });
const SHORT_DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const COLORS = { Moving: "#da642f", Parking: "#1d5e76" };
const POINT_COLORS = { Moving: [218, 100, 47, 190], Parking: [29, 94, 118, 175] };
const PALETTES = {
  district: [[247,244,232,0],[180,211,215,120],[63,130,145,180],[218,100,47,220],[109,28,20,255]],
  fire: [[255,249,224,0],[254,217,118,125],[254,178,76,185],[240,59,32,225],[103,0,13,255]],
  blue: [[247,251,255,0],[198,219,239,125],[107,174,214,185],[33,113,181,225],[8,48,107,255]],
  purple: [[252,251,253,0],[218,218,235,125],[158,154,200,185],[117,107,177,225],[63,0,125,255]],
  viridis: [[68,1,84,0],[59,82,139,130],[33,145,140,190],[94,201,98,225],[253,231,37,255]],
};

const state = {
  manifest: null,
  db: null,
  connection: null,
  registered: new Set(),
  map: null,
  overlay: null,
  points: [],
  display: "heat",
  heat: { intensity: 1, radius: 34, opacity: 0.85, palette: "district" },
  domains: { minDay: 0, maxDay: 0, minFine: 0, maxFine: 0 },
  charts: {},
  histogramData: { dates: [], fines: [] },
  refreshTimer: null,
  requestId: 0,
  mapAvailable: false,
};

const elements = {
  notice: document.querySelector("#notice"),
  liveState: document.querySelector("#live-state"),
  reset: document.querySelector("#reset-filters"),
  moving: document.querySelector("#type-moving"),
  parking: document.querySelector("#type-parking"),
  agency: document.querySelector("#agency"),
  violation: document.querySelector("#violation"),
  plate: document.querySelector("#plate-state"),
  agencyOptions: document.querySelector("#agency-options"),
  violationOptions: document.querySelector("#violation-options"),
  plateOptions: document.querySelector("#plate-options"),
  dateRangeStart: document.querySelector("#date-range-start"),
  dateRangeEnd: document.querySelector("#date-range-end"),
  dateStart: document.querySelector("#date-start"),
  dateEnd: document.querySelector("#date-end"),
  dateSelectionLabel: document.querySelector("#date-selection-label"),
  fineRangeStart: document.querySelector("#fine-range-start"),
  fineRangeEnd: document.querySelector("#fine-range-end"),
  fineMin: document.querySelector("#fine-min"),
  fineMax: document.querySelector("#fine-max"),
  fineSelectionLabel: document.querySelector("#fine-selection-label"),
  activeFilters: document.querySelector("#active-filters"),
  count: document.querySelector("#metric-count"),
  pointCount: document.querySelector("#metric-points"),
  fines: document.querySelector("#metric-fines"),
  paid: document.querySelector("#metric-paid"),
  rate: document.querySelector("#metric-rate"),
  average: document.querySelector("#metric-average"),
  trendGranularity: document.querySelector("#trend-granularity"),
  mapNote: document.querySelector("#map-note"),
  heat: document.querySelector("#show-heat"),
  points: document.querySelector("#show-points"),
  heatControls: document.querySelector("#heat-controls"),
  heatIntensity: document.querySelector("#heat-intensity"),
  intensityValue: document.querySelector("#intensity-value"),
  heatRadius: document.querySelector("#heat-radius"),
  radiusValue: document.querySelector("#radius-value"),
  heatOpacity: document.querySelector("#heat-opacity"),
  opacityValue: document.querySelector("#opacity-value"),
  heatPalette: document.querySelector("#heat-palette"),
};

function showNotice(message, error = false) {
  elements.notice.textContent = message;
  elements.notice.classList.add("visible");
  elements.notice.classList.toggle("error", error);
}

function setLoading(loading) {
  elements.liveState.classList.toggle("loading", loading);
  elements.liveState.lastChild.textContent = loading ? " Updating" : " Live";
}

function sqlString(value) { return "'" + String(value).replaceAll("'", "''") + "'"; }
function numberValue(value) {
  if (typeof value === "bigint") return Number(value);
  const converted = Number(value ?? 0);
  return Number.isFinite(converted) ? converted : 0;
}
function tableRows(table) {
  return table.toArray().map((row) => typeof row.toJSON === "function" ? row.toJSON() : { ...row });
}
function isoToDay(value) { return Math.floor(Date.parse(value + "T00:00:00Z") / DAY_MS); }
function dayToIso(value) { return new Date(Number(value) * DAY_MS).toISOString().slice(0, 10); }
function displayDate(value) { return SHORT_DATE.format(new Date(value + "T00:00:00Z")); }

function selectedTypes() {
  const types = [];
  if (elements.moving.checked) types.push("Moving");
  if (elements.parking.checked) types.push("Parking");
  return types;
}

function currentFilters() {
  return {
    types: selectedTypes(),
    startDate: elements.dateStart.value,
    endDate: elements.dateEnd.value,
    agency: elements.agency.value.trim(),
    violation: elements.violation.value.trim(),
    plate: elements.plate.value.trim().toUpperCase(),
    fineMin: Number(elements.fineMin.value),
    fineMax: Number(elements.fineMax.value),
  };
}

function filterSql(selected, { includeDate = true, includeFine = true } = {}) {
  const clauses = ["violation_type IN (" + selected.types.map(sqlString).join(", ") + ")"];
  if (includeDate) {
    clauses.push("CAST(issue_date AS DATE) BETWEEN DATE " + sqlString(selected.startDate) + " AND DATE " + sqlString(selected.endDate));
  }
  if (selected.agency) clauses.push("strpos(lower(coalesce(agency, '')), lower(" + sqlString(selected.agency) + ")) > 0");
  if (selected.violation) clauses.push("strpos(lower(coalesce(violation, '')), lower(" + sqlString(selected.violation) + ")) > 0");
  if (selected.plate) clauses.push("upper(coalesce(plate_state, '')) = " + sqlString(selected.plate));
  if (includeFine) clauses.push("fine_amount BETWEEN " + selected.fineMin + " AND " + selected.fineMax);
  return clauses.join(" AND ");
}

async function initDatabase() {
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const workerUrl = URL.createObjectURL(new Blob(['importScripts("' + bundle.mainWorker + '");'], { type: "text/javascript" }));
  const worker = new Worker(workerUrl);
  state.db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
  await state.db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);
  state.connection = await state.db.connect();
}

async function registerFile(alias, relativePath) {
  if (state.registered.has(alias)) return;
  await state.db.registerFileURL(alias, new URL(relativePath, DATA_ROOT).href, duckdb.DuckDBDataProtocol.HTTP, false);
  state.registered.add(alias);
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function latestCompletePartition() {
  const ready = state.manifest.partitions
    .filter((item) => item.status === "ready" && item.path)
    .sort((a, b) => a.year - b.year || a.month - b.month);
  const periods = [...new Set(ready.map((item) => item.year + "-" + item.month))]
    .map((key) => { const [year, month] = key.split("-").map(Number); return { year, month }; })
    .sort((a, b) => b.year - a.year || b.month - a.month);
  for (const period of periods) {
    const entries = ready.filter((item) => item.year === period.year && item.month === period.month);
    if (!["Moving", "Parking"].every((type) => entries.some((item) => item.violation_type === type))) continue;
    const likelyComplete = entries.every((item) => {
      const earlier = ready.filter((candidate) => candidate.violation_type === item.violation_type &&
        (candidate.year < item.year || (candidate.year === item.year && candidate.month < item.month)))
        .slice(-6).map((candidate) => Number(candidate.analysis_rows || 0)).filter((rows) => rows > 0);
      const baseline = median(earlier);
      return baseline === 0 || item.analysis_rows >= baseline * 0.35;
    });
    if (likelyComplete) return entries[0];
  }
  return ready.at(-1);
}

function monthOverlaps(item, selected) {
  const monthStart = item.year + "-" + String(item.month).padStart(2, "0") + "-01";
  const monthEnd = new Date(Date.UTC(item.year, item.month, 0)).toISOString().slice(0, 10);
  return monthStart <= selected.endDate && monthEnd >= selected.startDate;
}

function partitionFiles(selected) {
  return state.manifest.partitions.filter((item) => item.status === "ready" && item.path &&
    selected.types.includes(item.violation_type) && monthOverlaps(item, selected));
}

async function pointSource(selected) {
  const partitions = partitionFiles(selected);
  if (!partitions.length) return null;
  const aliases = [];
  for (const item of partitions) {
    const alias = "points_" + item.year + "_" + String(item.month).padStart(2, "0") + "_" + item.violation_type.toLowerCase() + ".parquet";
    await registerFile(alias, item.path);
    aliases.push(sqlString(alias));
  }
  return "read_parquet([" + aliases.join(", ") + "], union_by_name=true)";
}

async function initializeDomains() {
  const sql = [
    "SELECT",
    "  strftime(min(CAST(issue_date AS DATE)), '%Y-%m-%d') AS min_date,",
    "  strftime(max(CAST(issue_date AS DATE)), '%Y-%m-%d') AS max_date,",
    "  floor(min(fine_amount)) AS min_fine,",
    "  ceil(max(fine_amount)) AS max_fine",
    "FROM read_parquet('trend_summary.parquet')",
  ].join("\n");
  const row = tableRows(await state.connection.query(sql))[0];
  state.domains.minDay = isoToDay(String(row.min_date));
  state.domains.maxDay = isoToDay(String(row.max_date));
  state.domains.minFine = Math.max(0, numberValue(row.min_fine));
  state.domains.maxFine = Math.max(state.domains.minFine + 1, numberValue(row.max_fine));

  for (const input of [elements.dateRangeStart, elements.dateRangeEnd]) {
    input.min = state.domains.minDay;
    input.max = state.domains.maxDay;
    input.step = 1;
  }
  elements.dateStart.min = dayToIso(state.domains.minDay);
  elements.dateStart.max = dayToIso(state.domains.maxDay);
  elements.dateEnd.min = dayToIso(state.domains.minDay);
  elements.dateEnd.max = dayToIso(state.domains.maxDay);

  const latest = latestCompletePartition();
  const defaultStart = latest ? isoToDay(latest.year + "-" + String(latest.month).padStart(2, "0") + "-01") : state.domains.minDay;
  const defaultEnd = latest ? Math.min(state.domains.maxDay, isoToDay(new Date(Date.UTC(latest.year, latest.month, 0)).toISOString().slice(0, 10))) : state.domains.maxDay;
  setDateRange(defaultStart, defaultEnd);

  const fineStep = state.domains.maxFine > 500 ? 5 : 1;
  for (const input of [elements.fineRangeStart, elements.fineRangeEnd]) {
    input.min = state.domains.minFine;
    input.max = state.domains.maxFine;
    input.step = fineStep;
  }
  elements.fineMin.min = state.domains.minFine;
  elements.fineMin.max = state.domains.maxFine;
  elements.fineMax.min = state.domains.minFine;
  elements.fineMax.max = state.domains.maxFine;
  setFineRange(state.domains.minFine, state.domains.maxFine);
}

function setDateRange(start, end) {
  const low = Math.max(state.domains.minDay, Math.min(Number(start), state.domains.maxDay));
  const high = Math.max(low, Math.min(Number(end), state.domains.maxDay));
  elements.dateRangeStart.value = low;
  elements.dateRangeEnd.value = high;
  elements.dateStart.value = dayToIso(low);
  elements.dateEnd.value = dayToIso(high);
  elements.dateSelectionLabel.textContent = displayDate(elements.dateStart.value) + " – " + displayDate(elements.dateEnd.value);
  recolorHistograms();
}

function setFineRange(start, end) {
  const low = Math.max(state.domains.minFine, Math.min(Number(start), state.domains.maxFine));
  const high = Math.max(low, Math.min(Number(end), state.domains.maxFine));
  elements.fineRangeStart.value = low;
  elements.fineRangeEnd.value = high;
  elements.fineMin.value = low;
  elements.fineMax.value = high;
  elements.fineSelectionLabel.textContent = MONEY.format(low) + " – " + MONEY.format(high);
  recolorHistograms();
}

async function querySummary(selected) {
  const sql = [
    "SELECT coalesce(sum(violation_count), 0) AS violation_count,",
    "  coalesce(sum(fine_total), 0) AS fine_total,",
    "  coalesce(sum(paid_total), 0) AS paid_total",
    "FROM read_parquet('trend_summary.parquet')",
    "WHERE " + filterSql(selected),
  ].join("\n");
  return tableRows(await state.connection.query(sql))[0];
}

async function queryDateHistogram(selected) {
  const sql = [
    "SELECT strftime(date_trunc('month', issue_date), '%Y-%m') AS bucket,",
    "  sum(violation_count) AS violation_count",
    "FROM read_parquet('trend_summary.parquet')",
    "WHERE " + filterSql(selected, { includeDate: false, includeFine: true }),
    "GROUP BY bucket ORDER BY bucket",
  ].join("\n");
  return tableRows(await state.connection.query(sql));
}

async function queryFineHistogram(selected) {
  const sql = [
    "SELECT fine_amount, sum(violation_count) AS violation_count",
    "FROM read_parquet('trend_summary.parquet')",
    "WHERE " + filterSql(selected, { includeDate: true, includeFine: false }),
    "GROUP BY fine_amount ORDER BY fine_amount",
  ].join("\n");
  return tableRows(await state.connection.query(sql));
}

async function queryTrends(selected) {
  const days = isoToDay(selected.endDate) - isoToDay(selected.startDate) + 1;
  const unit = days <= 120 ? "day" : days <= 730 ? "week" : "month";
  const sql = [
    "SELECT strftime(date_trunc(" + sqlString(unit) + ", issue_date), '%Y-%m-%d') AS period,",
    "  violation_type, sum(violation_count) AS violation_count,",
    "  sum(fine_total) AS fine_total, sum(paid_total) AS paid_total",
    "FROM read_parquet('trend_summary.parquet')",
    "WHERE " + filterSql(selected),
    "GROUP BY period, violation_type ORDER BY period, violation_type",
  ].join("\n");
  return { unit, rows: tableRows(await state.connection.query(sql)) };
}

async function queryTopViolations(selected) {
  const sql = [
    "SELECT coalesce(nullif(trim(violation), ''), 'Unknown') AS violation,",
    "  sum(violation_count) AS violation_count",
    "FROM read_parquet('trend_summary.parquet')",
    "WHERE " + filterSql(selected),
    "GROUP BY 1 ORDER BY violation_count DESC LIMIT 10",
  ].join("\n");
  return tableRows(await state.connection.query(sql));
}

async function queryMapped(selected) {
  const source = await pointSource(selected);
  if (!source) return { hourly: [], points: [] };
  const where = filterSql(selected);
  const hourlySql = [
    "WITH filtered AS (SELECT try_cast(issue_hour AS INTEGER) AS hour, violation_type FROM " + source + " WHERE " + where + ")",
    "SELECT hour, violation_type, count(*) AS violation_count FROM filtered",
    "WHERE hour BETWEEN 0 AND 23 GROUP BY hour, violation_type ORDER BY hour, violation_type",
  ].join("\n");
  const hourly = tableRows(await state.connection.query(hourlySql));
  const pointsSql = [
    "SELECT latitude, longitude, issue_date, issue_hour, agency, violation, plate_state,",
    "  fine_amount, total_paid, location, violation_type FROM " + source,
    "WHERE " + where,
  ].join("\n");
  const rows = tableRows(await state.connection.query(pointsSql));
  const points = rows.map((row) => ({
    latitude: numberValue(row.latitude), longitude: numberValue(row.longitude), issueDate: row.issue_date,
    issueHour: row.issue_hour, agency: row.agency ?? "Unknown agency", violation: row.violation ?? "Unknown violation",
    plateState: row.plate_state ?? "Unknown", fineAmount: numberValue(row.fine_amount), totalPaid: numberValue(row.total_paid),
    location: row.location ?? "Location unavailable", violationType: row.violation_type,
  }));
  return { hourly, points };
}

async function loadFilterSuggestions() {
  const specs = [["agency", elements.agencyOptions, 60], ["violation", elements.violationOptions, 160], ["plate_state", elements.plateOptions, 80]];
  for (const [column, list, limit] of specs) {
    const sql = "SELECT " + column + " AS value, sum(violation_count) AS frequency FROM read_parquet('trend_summary.parquet') " +
      "WHERE " + column + " IS NOT NULL AND trim(" + column + ") <> '' GROUP BY " + column + " ORDER BY frequency DESC LIMIT " + limit;
    const rows = tableRows(await state.connection.query(sql));
    list.replaceChildren(...rows.map((row) => { const option = document.createElement("option"); option.value = String(row.value); return option; }));
  }
}

function binFines(rows, count = 26) {
  const min = state.domains.minFine;
  const max = state.domains.maxFine;
  const width = Math.max(1, (max - min) / count);
  const bins = Array.from({ length: count }, (_, index) => ({
    low: min + index * width,
    high: index === count - 1 ? max : min + (index + 1) * width,
    count: 0,
  }));
  for (const row of rows) {
    const value = numberValue(row.fine_amount);
    const index = Math.min(count - 1, Math.max(0, Math.floor((value - min) / width)));
    bins[index].count += numberValue(row.violation_count);
  }
  return bins;
}

function histogramOptions(formatter) {
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    plugins: { legend: { display: false }, tooltip: { callbacks: { label: (context) => NUMBER.format(context.raw) + " citations" } } },
    scales: {
      x: { grid: { display: false }, ticks: { color: "#657278", autoSkip: true, maxTicksLimit: 8, maxRotation: 0 } },
      y: { beginAtZero: true, grid: { color: "rgba(101,114,120,0.12)" }, ticks: { color: "#657278", maxTicksLimit: 4, callback: formatter } },
    },
  };
}

function renderHistograms(dateRows, fineRows) {
  state.histogramData.dates = dateRows;
  state.histogramData.fines = binFines(fineRows);
  state.charts.dateHistogram?.destroy();
  state.charts.fineHistogram?.destroy();
  state.charts.dateHistogram = new Chart(document.querySelector("#date-histogram"), {
    type: "bar",
    data: { labels: dateRows.map((row) => row.bucket), datasets: [{ data: dateRows.map((row) => numberValue(row.violation_count)), borderWidth: 0, borderRadius: 2 }] },
    options: histogramOptions((value) => NUMBER.format(value)),
  });
  state.charts.fineHistogram = new Chart(document.querySelector("#fine-histogram"), {
    type: "bar",
    data: {
      labels: state.histogramData.fines.map((bin) => MONEY.format(bin.low)),
      datasets: [{ data: state.histogramData.fines.map((bin) => bin.count), borderWidth: 0, borderRadius: 2 }],
    },
    options: histogramOptions((value) => NUMBER.format(value)),
  });
  recolorHistograms();
}

function recolorHistograms() {
  const startDate = elements.dateStart.value;
  const endDate = elements.dateEnd.value;
  if (state.charts.dateHistogram) {
    state.charts.dateHistogram.data.datasets[0].backgroundColor = state.histogramData.dates.map((row) => {
      const bucketStart = row.bucket + "-01";
      const [year, month] = row.bucket.split("-").map(Number);
      const bucketEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
      return bucketStart <= endDate && bucketEnd >= startDate ? "#1d5e76d9" : "#bbc5c8a8";
    });
    state.charts.dateHistogram.update("none");
  }
  const fineMin = Number(elements.fineMin.value || 0);
  const fineMax = Number(elements.fineMax.value || 0);
  if (state.charts.fineHistogram) {
    state.charts.fineHistogram.data.datasets[0].backgroundColor = state.histogramData.fines.map((bin) =>
      bin.high >= fineMin && bin.low <= fineMax ? "#da642fd9" : "#c8c2b8a8"
    );
    state.charts.fineHistogram.update("none");
  }
}

function lineOptions(formatter) {
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: "index", intersect: false },
    plugins: { legend: { labels: { color: "#34444a", font: { family: "system-ui" }, usePointStyle: true } } },
    scales: {
      x: { grid: { display: false }, ticks: { color: "#657278", autoSkip: true, maxTicksLimit: 4, maxRotation: 0 } },
      y: { beginAtZero: true, grid: { color: "rgba(101,114,120,0.16)" }, ticks: { color: "#657278", callback: formatter } },
    },
  };
}

function typedSeries(rows, valueKey) {
  const labels = [...new Set(rows.map((row) => String(row.period)))].sort();
  const datasets = [...new Set(rows.map((row) => row.violation_type))].map((type) => {
    const values = new Map(rows.filter((row) => row.violation_type === type).map((row) => [String(row.period), numberValue(row[valueKey])]));
    return { label: type, data: labels.map((label) => values.get(label) ?? 0), borderColor: COLORS[type], backgroundColor: COLORS[type] + "20", borderWidth: 2, pointRadius: 1.5, pointHoverRadius: 5, tension: 0.18 };
  });
  return { labels, datasets };
}

function renderCharts(trend, topRows, hourlyRows) {
  for (const name of ["daily", "money", "hour", "top"]) state.charts[name]?.destroy();
  const countSeries = typedSeries(trend.rows, "violation_count");
  state.charts.daily = new Chart(document.querySelector("#daily-chart"), { type: "line", data: countSeries, options: lineOptions((value) => NUMBER.format(value)) });
  elements.trendGranularity.textContent = trend.unit[0].toUpperCase() + trend.unit.slice(1) + "ly · exact records";

  const labels = [...new Set(trend.rows.map((row) => String(row.period)))].sort();
  const money = new Map();
  for (const row of trend.rows) {
    const current = money.get(String(row.period)) ?? { fine: 0, paid: 0 };
    current.fine += numberValue(row.fine_total); current.paid += numberValue(row.paid_total); money.set(String(row.period), current);
  }
  state.charts.money = new Chart(document.querySelector("#money-chart"), {
    type: "line",
    data: { labels, datasets: [
      { label: "Fines issued", data: labels.map((x) => money.get(x)?.fine ?? 0), borderColor: COLORS.Moving, borderWidth: 2, pointRadius: 1.5, tension: 0.18 },
      { label: "Total paid", data: labels.map((x) => money.get(x)?.paid ?? 0), borderColor: COLORS.Parking, borderWidth: 2, pointRadius: 1.5, tension: 0.18 },
    ] },
    options: lineOptions((value) => MONEY.format(value)),
  });

  const hourLabels = Array.from({ length: 24 }, (_, hour) => new Date(2000, 0, 1, hour).toLocaleTimeString("en-US", { hour: "numeric" }));
  state.charts.hour = new Chart(document.querySelector("#hour-chart"), {
    type: "bar",
    data: { labels: hourLabels, datasets: selectedTypes().filter((type) => hourlyRows.some((row) => row.violation_type === type)).map((type) => {
      const values = new Map(hourlyRows.filter((row) => row.violation_type === type).map((row) => [numberValue(row.hour), numberValue(row.violation_count)]));
      return { label: type, data: Array.from({ length: 24 }, (_, hour) => values.get(hour) ?? 0), backgroundColor: COLORS[type] + "c7", borderRadius: 2 };
    }) },
    options: { ...lineOptions((value) => NUMBER.format(value)), scales: { x: { stacked: true, grid: { display: false }, ticks: { color: "#657278", autoSkip: true, maxTicksLimit: 8 } }, y: { stacked: true, beginAtZero: true, grid: { color: "rgba(101,114,120,0.16)" }, ticks: { color: "#657278", callback: (value) => NUMBER.format(value) } } } },
  });

  const shorten = (value) => value.length > 20 ? value.slice(0, 17) + "…" : value;
  state.charts.top = new Chart(document.querySelector("#top-chart"), {
    type: "bar",
    data: { labels: topRows.map((row) => shorten(String(row.violation))), datasets: [{ label: "Citations", data: topRows.map((row) => numberValue(row.violation_count)), backgroundColor: "#1d5e76c7", borderRadius: 3 }] },
    options: { ...lineOptions((value) => NUMBER.format(value)), indexAxis: "y", plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, grid: { color: "rgba(101,114,120,0.16)" }, ticks: { color: "#657278", callback: (value) => NUMBER.format(value) } }, y: { grid: { display: false }, ticks: { color: "#657278" } } } },
  });
}

function escapeHtml(value) { const node = document.createElement("span"); node.textContent = String(value ?? ""); return node.innerHTML; }
function tooltip({ object }) {
  if (!object) return null;
  const date = object.issueDate ? new Date(object.issueDate).toLocaleDateString("en-US") : "Date unavailable";
  return { html: '<div class="popup-title">' + escapeHtml(object.violation) + "</div>" +
    '<div class="popup-row">' + escapeHtml(object.location) + "</div>" +
    '<div class="popup-row">' + escapeHtml(object.agency) + " · " + escapeHtml(object.violationType) + "</div>" +
    '<div class="popup-row">' + escapeHtml(date) + " · " + MONEY.format(object.fineAmount) + " fine · " + MONEY.format(object.totalPaid) + " paid</div>" +
    '<div class="popup-row">Plate state: ' + escapeHtml(object.plateState) + "</div>" };
}

function renderMap() {
  if (!state.overlay) return;
  const common = { data: state.points, getPosition: (item) => [item.longitude, item.latitude] };
  const layer = state.display === "heat"
    ? new deck.HeatmapLayer({ id: "violations-heat", ...common, getWeight: 1, radiusPixels: state.heat.radius, intensity: state.heat.intensity, opacity: state.heat.opacity, threshold: 0.03, colorRange: PALETTES[state.heat.palette] })
    : new deck.ScatterplotLayer({ id: "violations-points", ...common, getFillColor: (item) => POINT_COLORS[item.violationType], getRadius: 3, radiusUnits: "pixels", radiusMinPixels: 1.5, radiusMaxPixels: 6, pickable: true, autoHighlight: true });
  state.overlay.setProps({ layers: [layer], getTooltip: tooltip });
}

function renderMetrics(summary, pointCount = null) {
  const count = numberValue(summary.violation_count), fines = numberValue(summary.fine_total), paid = numberValue(summary.paid_total);
  const values = [[elements.count, NUMBER.format(count)], [elements.fines, MONEY.format(fines)], [elements.paid, MONEY.format(paid)],
    [elements.rate, fines > 0 ? PERCENT.format(paid / fines) : "—"], [elements.average, count > 0 ? MONEY.format(fines / count) : "—"]];
  for (const [element, value] of values) { element.textContent = value; element.title = value; }
  elements.pointCount.textContent = pointCount === null ? "…" : NUMBER.format(pointCount);
  elements.pointCount.title = pointCount === null ? "Loading mapped records" : NUMBER.format(pointCount);
}

function updateActiveFilters() {
  const selected = currentFilters();
  const chips = [selected.types.length ? selected.types.join(" + ") : "No category", displayDate(selected.startDate) + " – " + displayDate(selected.endDate), MONEY.format(selected.fineMin) + " – " + MONEY.format(selected.fineMax)];
  if (selected.agency) chips.push("Agency: " + selected.agency);
  if (selected.violation) chips.push("Violation: " + selected.violation);
  if (selected.plate) chips.push("Plate: " + selected.plate);
  elements.activeFilters.replaceChildren(...chips.map((text) => { const chip = document.createElement("span"); chip.className = "filter-chip"; chip.textContent = text; return chip; }));
}

async function refresh() {
  const requestId = ++state.requestId;
  const selected = currentFilters();
  updateActiveFilters();
  if (!selected.types.length) { showNotice("Select at least one violation category.", true); setLoading(false); return; }
  setLoading(true);
  showNotice("Updating exact totals, histograms, trends, and mapped records…");
  try {
    const summary = await querySummary(selected);
    if (requestId !== state.requestId) return;
    renderMetrics(summary);
    const dateRows = await queryDateHistogram(selected);
    if (requestId !== state.requestId) return;
    const fineRows = await queryFineHistogram(selected);
    if (requestId !== state.requestId) return;
    renderHistograms(dateRows, fineRows);
    const trend = await queryTrends(selected);
    if (requestId !== state.requestId) return;
    const topRows = await queryTopViolations(selected);
    if (requestId !== state.requestId) return;
    const mapped = await queryMapped(selected);
    if (requestId !== state.requestId) return;
    state.points = mapped.points;
    renderMetrics(summary, mapped.points.length);
    renderCharts(trend, topRows, mapped.hourly);
    renderMap();
    const total = numberValue(summary.violation_count);
    const omitted = Math.max(0, total - mapped.points.length);
    elements.mapNote.textContent = state.mapAvailable
      ? (omitted > 0 ? "All " + NUMBER.format(mapped.points.length) + " valid locations mapped; " + NUMBER.format(omitted) + " records lack usable coordinates." : "All " + NUMBER.format(mapped.points.length) + " filtered records are mapped.")
      : NUMBER.format(mapped.points.length) + " records have valid coordinates; the map is unavailable in this browser.";
    showNotice("Showing " + NUMBER.format(total) + " exact records and " + NUMBER.format(mapped.points.length) + " mapped locations. Data build: " + new Date(state.manifest.generated_at).toLocaleString("en-US") + ".");
  } catch (error) {
    console.error(error);
    if (requestId === state.requestId) showNotice("The dashboard could not load this selection. Narrow the date range or check the data deployment.", true);
  } finally {
    if (requestId === state.requestId) setLoading(false);
  }
}

function scheduleRefresh(delay = 320) {
  clearTimeout(state.refreshTimer);
  state.requestId += 1;
  setLoading(true);
  state.refreshTimer = setTimeout(refresh, delay);
}

function handleDateSlider(changed) {
  let start = Number(elements.dateRangeStart.value), end = Number(elements.dateRangeEnd.value);
  if (start > end) { if (changed === "start") end = start; else start = end; }
  setDateRange(start, end); updateActiveFilters(); scheduleRefresh();
}
function handleFineSlider(changed) {
  let start = Number(elements.fineRangeStart.value), end = Number(elements.fineRangeEnd.value);
  if (start > end) { if (changed === "start") end = start; else start = end; }
  setFineRange(start, end); updateActiveFilters(); scheduleRefresh();
}

function setDisplay(display) {
  state.display = display;
  const heat = display === "heat";
  elements.heat.classList.toggle("active", heat); elements.points.classList.toggle("active", !heat);
  elements.heat.setAttribute("aria-pressed", String(heat)); elements.points.setAttribute("aria-pressed", String(!heat));
  elements.heatControls.hidden = !heat; renderMap();
}

function updateHeatStyle() {
  state.heat.intensity = Number(elements.heatIntensity.value); state.heat.radius = Number(elements.heatRadius.value);
  state.heat.opacity = Number(elements.heatOpacity.value); state.heat.palette = elements.heatPalette.value;
  elements.intensityValue.textContent = state.heat.intensity.toFixed(2).replace(/0$/, "") + "×";
  elements.radiusValue.textContent = state.heat.radius + " px"; elements.opacityValue.textContent = Math.round(state.heat.opacity * 100) + "%";
  renderMap();
}

function resetFilters() {
  elements.moving.checked = true; elements.parking.checked = true;
  elements.agency.value = ""; elements.violation.value = ""; elements.plate.value = "";
  const latest = latestCompletePartition();
  const start = latest ? isoToDay(latest.year + "-" + String(latest.month).padStart(2, "0") + "-01") : state.domains.minDay;
  const end = latest ? Math.min(state.domains.maxDay, isoToDay(new Date(Date.UTC(latest.year, latest.month, 0)).toISOString().slice(0, 10))) : state.domains.maxDay;
  setDateRange(start, end); setFineRange(state.domains.minFine, state.domains.maxFine); updateActiveFilters(); refresh();
}

async function initMap() {
  state.map = new maplibregl.Map({ container: "map", style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json", center: [-77.01, 38.91], zoom: 11.1, minZoom: 9, maxZoom: 18 });
  state.map.addControl(new maplibregl.NavigationControl(), "top-right");
  await new Promise((resolve) => state.map.once("load", resolve));
  state.overlay = new deck.MapboxOverlay({ interleaved: false, layers: [], getTooltip: tooltip });
  state.map.addControl(state.overlay);
  state.mapAvailable = true;
}

function bindControls() {
  elements.reset.addEventListener("click", resetFilters);
  elements.heat.addEventListener("click", () => setDisplay("heat"));
  elements.points.addEventListener("click", () => setDisplay("points"));
  for (const control of [elements.heatIntensity, elements.heatRadius, elements.heatOpacity]) control.addEventListener("input", updateHeatStyle);
  elements.heatPalette.addEventListener("change", updateHeatStyle);

  elements.dateRangeStart.addEventListener("input", () => handleDateSlider("start"));
  elements.dateRangeEnd.addEventListener("input", () => handleDateSlider("end"));
  elements.fineRangeStart.addEventListener("input", () => handleFineSlider("start"));
  elements.fineRangeEnd.addEventListener("input", () => handleFineSlider("end"));
  elements.dateStart.addEventListener("change", () => {
    const start = isoToDay(elements.dateStart.value), end = Number(elements.dateRangeEnd.value);
    setDateRange(start, Math.max(start, end)); updateActiveFilters(); scheduleRefresh(50);
  });
  elements.dateEnd.addEventListener("change", () => {
    const start = Number(elements.dateRangeStart.value), end = isoToDay(elements.dateEnd.value);
    setDateRange(Math.min(start, end), end); updateActiveFilters(); scheduleRefresh(50);
  });
  elements.fineMin.addEventListener("change", () => {
    const start = Number(elements.fineMin.value), end = Number(elements.fineRangeEnd.value);
    setFineRange(start, Math.max(start, end)); updateActiveFilters(); scheduleRefresh(50);
  });
  elements.fineMax.addEventListener("change", () => {
    const start = Number(elements.fineRangeStart.value), end = Number(elements.fineMax.value);
    setFineRange(Math.min(start, end), end); updateActiveFilters(); scheduleRefresh(50);
  });

  for (const [start, end] of [[elements.dateRangeStart, elements.dateRangeEnd], [elements.fineRangeStart, elements.fineRangeEnd]]) {
    start.addEventListener("pointerdown", () => { start.style.zIndex = 4; end.style.zIndex = 2; });
    end.addEventListener("pointerdown", () => { end.style.zIndex = 4; start.style.zIndex = 2; });
  }

  for (const input of [elements.moving, elements.parking]) input.addEventListener("change", () => { updateActiveFilters(); scheduleRefresh(50); });
  for (const input of [elements.agency, elements.violation, elements.plate]) input.addEventListener("input", () => { updateActiveFilters(); scheduleRefresh(420); });
}

async function bootstrap() {
  showNotice("Preparing the complete dashboard dataset…");
  const response = await fetch(new URL("manifest.json", DATA_ROOT));
  if (!response.ok) throw new Error("Manifest request failed: " + response.status);
  state.manifest = await response.json();
  if (state.manifest.schema_version < 2 || state.manifest.summary_granularity !== "day") throw new Error("Dashboard data must be refreshed to schema version 2.");
  const mapInit = initMap().catch((error) => {
    console.warn("Map unavailable; continuing without WebGL.", error);
    const mapElement = document.querySelector("#map");
    mapElement.classList.add("map-unavailable");
    mapElement.textContent = "The map cannot run in this browser. All non-map analysis remains available.";
    elements.heatControls.hidden = true;
  });
  await Promise.all([initDatabase(), mapInit]);
  await registerFile("trend_summary.parquet", state.manifest.trend_summary);
  await initializeDomains();
  updateHeatStyle(); updateActiveFilters(); bindControls();
  await refresh();
  await loadFilterSuggestions();
}

bootstrap().catch((error) => { console.error(error); setLoading(false); showNotice("The dashboard data is not available yet. Check the data-refresh and Pages workflows.", true); });
