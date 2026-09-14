import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/+esm";

const DATA_ROOT = new URL("data/", window.location.href);
const NUMBER = new Intl.NumberFormat("en-US");
const MONEY = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const PERCENT = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 1,
});
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const COLORS = {
  Moving: "#da642f",
  Parking: "#1d5e76",
};
const POINT_COLORS = {
  Moving: [218, 100, 47, 190],
  Parking: [29, 94, 118, 175],
};
const PALETTES = {
  district: [
    [247, 244, 232, 0], [180, 211, 215, 120], [63, 130, 145, 180],
    [218, 100, 47, 220], [109, 28, 20, 255],
  ],
  fire: [
    [255, 249, 224, 0], [254, 217, 118, 125], [254, 178, 76, 185],
    [240, 59, 32, 225], [103, 0, 13, 255],
  ],
  blue: [
    [247, 251, 255, 0], [198, 219, 239, 125], [107, 174, 214, 185],
    [33, 113, 181, 225], [8, 48, 107, 255],
  ],
  purple: [
    [252, 251, 253, 0], [218, 218, 235, 125], [158, 154, 200, 185],
    [117, 107, 177, 225], [63, 0, 125, 255],
  ],
  viridis: [
    [68, 1, 84, 0], [59, 82, 139, 130], [33, 145, 140, 190],
    [94, 201, 98, 225], [253, 231, 37, 255],
  ],
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
  charts: {},
  requestId: 0,
};

const elements = {
  notice: document.querySelector("#notice"),
  apply: document.querySelector("#apply-filters"),
  reset: document.querySelector("#reset-filters"),
  moving: document.querySelector("#type-moving"),
  parking: document.querySelector("#type-parking"),
  year: document.querySelector("#year"),
  month: document.querySelector("#month"),
  agency: document.querySelector("#agency"),
  violation: document.querySelector("#violation"),
  plate: document.querySelector("#plate-state"),
  fineMin: document.querySelector("#fine-min"),
  fineMax: document.querySelector("#fine-max"),
  activeFilters: document.querySelector("#active-filters"),
  periodPreview: document.querySelector("#period-preview"),
  agencyOptions: document.querySelector("#agency-options"),
  violationOptions: document.querySelector("#violation-options"),
  plateOptions: document.querySelector("#plate-options"),
  count: document.querySelector("#metric-count"),
  pointCount: document.querySelector("#metric-points"),
  fines: document.querySelector("#metric-fines"),
  paid: document.querySelector("#metric-paid"),
  rate: document.querySelector("#metric-rate"),
  average: document.querySelector("#metric-average"),
  mapNote: document.querySelector("#map-note"),
  dailyNote: document.querySelector("#daily-note"),
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

function sqlString(value) {
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function numberValue(value) {
  if (typeof value === "bigint") return Number(value);
  const converted = Number(value ?? 0);
  return Number.isFinite(converted) ? converted : 0;
}

function tableRows(table) {
  return table.toArray().map((row) => {
    if (typeof row.toJSON === "function") return row.toJSON();
    return { ...row };
  });
}

function selectedTypes() {
  const types = [];
  if (elements.moving.checked) types.push("Moving");
  if (elements.parking.checked) types.push("Parking");
  return types;
}

function currentFilters() {
  const fineMin = elements.fineMin.value === "" ? null : Number(elements.fineMin.value);
  const fineMax = elements.fineMax.value === "" ? null : Number(elements.fineMax.value);
  return {
    types: selectedTypes(),
    year: Number(elements.year.value),
    month: Number(elements.month.value) + 1,
    agency: elements.agency.value.trim(),
    violation: elements.violation.value.trim(),
    plate: elements.plate.value.trim().toUpperCase(),
    fineMin,
    fineMax,
  };
}

function filterSql(selected, includeTypes = true) {
  const clauses = [];
  if (includeTypes) {
    clauses.push(
      "violation_type IN (" + selected.types.map(sqlString).join(", ") + ")"
    );
  }
  if (selected.agency) {
    clauses.push(
      "strpos(lower(coalesce(agency, '')), lower(" + sqlString(selected.agency) + ")) > 0"
    );
  }
  if (selected.violation) {
    clauses.push(
      "strpos(lower(coalesce(violation, '')), lower(" + sqlString(selected.violation) + ")) > 0"
    );
  }
  if (selected.plate) {
    clauses.push("upper(coalesce(plate_state, '')) = " + sqlString(selected.plate));
  }
  if (Number.isFinite(selected.fineMin)) clauses.push("fine_amount >= " + selected.fineMin);
  if (Number.isFinite(selected.fineMax)) clauses.push("fine_amount <= " + selected.fineMax);
  return clauses.length ? clauses.join(" AND ") : "TRUE";
}

async function initDatabase() {
  const bundles = duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle(bundles);
  const workerCode = 'importScripts("' + bundle.mainWorker + '");';
  const workerUrl = URL.createObjectURL(new Blob([workerCode], { type: "text/javascript" }));
  const worker = new Worker(workerUrl);
  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
  state.db = new duckdb.AsyncDuckDB(logger, worker);
  await state.db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);
  state.connection = await state.db.connect();
}

async function registerFile(alias, relativePath) {
  if (state.registered.has(alias)) return;
  await state.db.registerFileURL(
    alias,
    new URL(relativePath, DATA_ROOT).href,
    duckdb.DuckDBDataProtocol.HTTP,
    false
  );
  state.registered.add(alias);
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function latestCompletePartition() {
  const now = new Date();
  const currentKey = now.getUTCFullYear() * 12 + now.getUTCMonth();
  const ready = state.manifest.partitions
    .filter((item) => item.status === "ready" && item.path)
    .filter((item) => item.year * 12 + item.month - 1 < currentKey)
    .sort((a, b) => a.year - b.year || a.month - b.month);

  const periods = [...new Set(ready.map((item) => item.year + "-" + item.month))]
    .map((key) => {
      const [year, month] = key.split("-").map(Number);
      return { year, month };
    })
    .sort((a, b) => b.year - a.year || b.month - a.month);

  for (const period of periods) {
    const entries = ready.filter(
      (item) => item.year === period.year && item.month === period.month
    );
    if (!["Moving", "Parking"].every(
      (type) => entries.some((item) => item.violation_type === type)
    )) continue;

    const likelyComplete = entries.every((item) => {
      const earlier = ready
        .filter(
          (candidate) =>
            candidate.violation_type === item.violation_type &&
            (candidate.year < item.year ||
              (candidate.year === item.year && candidate.month < item.month))
        )
        .slice(-6)
        .map((candidate) => Number(candidate.analysis_rows || 0))
        .filter((rows) => rows > 0);
      const baseline = median(earlier);
      return baseline === 0 || item.analysis_rows >= baseline * 0.35;
    });
    if (likelyComplete) return entries[0];
  }
  return ready.at(-1);
}

function partitionFiles(selected) {
  return state.manifest.partitions.filter(
    (item) =>
      item.status === "ready" &&
      item.year === selected.year &&
      item.month === selected.month &&
      selected.types.includes(item.violation_type) &&
      item.path
  );
}

async function pointSource(selected) {
  const partitions = partitionFiles(selected);
  if (!partitions.length) return null;
  const aliases = [];
  for (const item of partitions) {
    const alias =
      "points_" + item.year + "_" + String(item.month).padStart(2, "0") +
      "_" + item.violation_type.toLowerCase() + ".parquet";
    await registerFile(alias, item.path);
    aliases.push(sqlString(alias));
  }
  return "read_parquet([" + aliases.join(", ") + "])";
}

async function querySummary(selected) {
  const month = String(selected.month).padStart(2, "0");
  const where = filterSql(selected, true) +
    " AND year_month = " + sqlString(selected.year + "-" + month);
  const sql = [
    "SELECT",
    "  coalesce(sum(violation_count), 0) AS violation_count,",
    "  coalesce(sum(fine_total), 0) AS fine_total,",
    "  coalesce(sum(paid_total), 0) AS paid_total",
    "FROM read_parquet('trend_summary.parquet')",
    "WHERE " + where,
  ].join("\n");
  return tableRows(await state.connection.query(sql))[0];
}

async function queryTrends(selected) {
  const sql = [
    "SELECT year_month, violation_type,",
    "  sum(violation_count) AS violation_count,",
    "  sum(fine_total) AS fine_total,",
    "  sum(paid_total) AS paid_total",
    "FROM read_parquet('trend_summary.parquet')",
    "WHERE " + filterSql(selected, true),
    "GROUP BY year_month, violation_type",
    "ORDER BY year_month, violation_type",
  ].join("\n");
  return tableRows(await state.connection.query(sql));
}

async function querySelectedInsights(selected) {
  const source = await pointSource(selected);
  if (!source) return { daily: [], hourly: [], top: [] };
  const where = filterSql(selected, false);

  const dailySql = [
    "SELECT strftime(CAST(issue_date AS DATE), '%Y-%m-%d') AS period,",
    "  violation_type, count(*) AS violation_count",
    "FROM " + source,
    "WHERE " + where,
    "GROUP BY period, violation_type",
    "ORDER BY period, violation_type",
  ].join("\n");
  const daily = tableRows(await state.connection.query(dailySql));

  const hourlySql = [
    "WITH filtered AS (",
    "  SELECT try_cast(issue_hour AS INTEGER) AS hour, violation_type",
    "  FROM " + source,
    "  WHERE " + where,
    ")",
    "SELECT hour, violation_type, count(*) AS violation_count",
    "FROM filtered WHERE hour BETWEEN 0 AND 23",
    "GROUP BY hour, violation_type ORDER BY hour, violation_type",
  ].join("\n");
  const hourly = tableRows(await state.connection.query(hourlySql));

  const topSql = [
    "SELECT coalesce(nullif(trim(violation), ''), 'Unknown') AS violation,",
    "  count(*) AS violation_count",
    "FROM " + source,
    "WHERE " + where,
    "GROUP BY 1 ORDER BY violation_count DESC LIMIT 10",
  ].join("\n");
  const top = tableRows(await state.connection.query(topSql));
  return { daily, hourly, top };
}

async function queryPoints(selected) {
  const source = await pointSource(selected);
  if (!source) return [];
  const sql = [
    "SELECT latitude, longitude, issue_date, issue_hour, agency, violation,",
    "  plate_state, fine_amount, total_paid, location, violation_type",
    "FROM " + source,
    "WHERE " + filterSql(selected, false),
  ].join("\n");
  const result = await state.connection.query(sql);
  return tableRows(result).map((row) => ({
    latitude: numberValue(row.latitude),
    longitude: numberValue(row.longitude),
    issueDate: row.issue_date,
    issueHour: row.issue_hour,
    agency: row.agency ?? "Unknown agency",
    violation: row.violation ?? "Unknown violation",
    plateState: row.plate_state ?? "Unknown",
    fineAmount: numberValue(row.fine_amount),
    totalPaid: numberValue(row.total_paid),
    location: row.location ?? "Location unavailable",
    violationType: row.violation_type,
  }));
}

async function loadFilterSuggestions() {
  const specs = [
    ["agency", elements.agencyOptions, 60],
    ["violation", elements.violationOptions, 160],
    ["plate_state", elements.plateOptions, 80],
  ];
  for (const [column, list, limit] of specs) {
    const sql = [
      "SELECT " + column + " AS value, sum(violation_count) AS frequency",
      "FROM read_parquet('trend_summary.parquet')",
      "WHERE " + column + " IS NOT NULL AND trim(" + column + ") <> ''",
      "GROUP BY " + column + " ORDER BY frequency DESC LIMIT " + limit,
    ].join("\n");
    const rows = tableRows(await state.connection.query(sql));
    list.replaceChildren(...rows.map((row) => {
      const option = document.createElement("option");
      option.value = String(row.value);
      return option;
    }));
  }
}

function escapeHtml(value) {
  const node = document.createElement("span");
  node.textContent = String(value ?? "");
  return node.innerHTML;
}

function tooltip({ object }) {
  if (!object) return null;
  const date = object.issueDate
    ? new Date(object.issueDate).toLocaleDateString("en-US")
    : "Date unavailable";
  return {
    html:
      '<div class="popup-title">' + escapeHtml(object.violation) + "</div>" +
      '<div class="popup-row">' + escapeHtml(object.location) + "</div>" +
      '<div class="popup-row">' + escapeHtml(object.agency) + " · " +
        escapeHtml(object.violationType) + "</div>" +
      '<div class="popup-row">' + escapeHtml(date) + " · " +
        MONEY.format(object.fineAmount) + " fine · " +
        MONEY.format(object.totalPaid) + " paid</div>" +
      '<div class="popup-row">Plate state: ' + escapeHtml(object.plateState) + "</div>",
  };
}

function renderMap() {
  if (!state.overlay) return;
  const common = {
    data: state.points,
    getPosition: (item) => [item.longitude, item.latitude],
  };
  const layer = state.display === "heat"
    ? new deck.HeatmapLayer({
        id: "violations-heat",
        ...common,
        getWeight: 1,
        radiusPixels: state.heat.radius,
        intensity: state.heat.intensity,
        opacity: state.heat.opacity,
        threshold: 0.03,
        colorRange: PALETTES[state.heat.palette],
      })
    : new deck.ScatterplotLayer({
        id: "violations-points",
        ...common,
        getFillColor: (item) => POINT_COLORS[item.violationType],
        getRadius: 3,
        radiusUnits: "pixels",
        radiusMinPixels: 1.5,
        radiusMaxPixels: 6,
        pickable: true,
        autoHighlight: true,
      });
  state.overlay.setProps({ layers: [layer], getTooltip: tooltip });
}

function renderMetrics(summary, pointCount) {
  const count = numberValue(summary.violation_count);
  const fines = numberValue(summary.fine_total);
  const paid = numberValue(summary.paid_total);
  elements.count.textContent = NUMBER.format(count);
  elements.pointCount.textContent = NUMBER.format(pointCount);
  elements.fines.textContent = MONEY.format(fines);
  elements.paid.textContent = MONEY.format(paid);
  elements.rate.textContent = fines > 0 ? PERCENT.format(paid / fines) : "—";
  elements.average.textContent = count > 0 ? MONEY.format(fines / count) : "—";
}

function chartOptions(yFormatter, { indexAxis = "x", legend = true, stacked = false } = {}) {
  const categoryAxis = { grid: { display: false }, ticks: { color: "#657278" } };
  const valueAxis = {
    beginAtZero: true,
    stacked,
    grid: { color: "rgba(101,114,120,0.16)" },
    ticks: { color: "#657278", callback: yFormatter },
  };
  categoryAxis.stacked = stacked;
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    indexAxis,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: {
        display: legend,
        labels: { color: "#34444a", font: { family: "Public Sans" }, usePointStyle: true },
      },
    },
    scales: indexAxis === "y"
      ? { x: valueAxis, y: categoryAxis }
      : { x: categoryAxis, y: valueAxis },
  };
}

function destroyChart(name) {
  state.charts[name]?.destroy();
}

function seriesDatasets(rows, labelKey, valueKey, { fill = false, type = "line" } = {}) {
  const labels = [...new Set(rows.map((row) => String(row[labelKey])))].sort();
  const types = [...new Set(rows.map((row) => row.violation_type))];
  const datasets = types.map((violationType) => {
    const values = new Map(
      rows.filter((row) => row.violation_type === violationType)
        .map((row) => [String(row[labelKey]), numberValue(row[valueKey])])
    );
    return {
      label: violationType,
      data: labels.map((label) => values.get(label) ?? 0),
      borderColor: COLORS[violationType],
      backgroundColor: type === "bar"
        ? COLORS[violationType] + "b8"
        : COLORS[violationType] + "20",
      pointRadius: type === "line" ? 1.5 : 0,
      pointHoverRadius: 5,
      borderWidth: 2,
      tension: 0.18,
      fill,
    };
  });
  return { labels, datasets };
}

function renderCharts(trends, insights, selected) {
  for (const name of ["count", "money", "daily", "hour", "top"]) destroyChart(name);

  const monthly = seriesDatasets(trends, "year_month", "violation_count");
  state.charts.count = new Chart(document.querySelector("#count-chart"), {
    type: "line",
    data: monthly,
    options: chartOptions((value) => NUMBER.format(value)),
  });

  const moneyByMonth = new Map();
  for (const row of trends) {
    const current = moneyByMonth.get(row.year_month) ?? { fine: 0, paid: 0 };
    current.fine += numberValue(row.fine_total);
    current.paid += numberValue(row.paid_total);
    moneyByMonth.set(row.year_month, current);
  }
  const moneyLabels = [...moneyByMonth.keys()].sort();
  state.charts.money = new Chart(document.querySelector("#money-chart"), {
    type: "line",
    data: {
      labels: moneyLabels,
      datasets: [
        {
          label: "Fines issued", data: moneyLabels.map((x) => moneyByMonth.get(x).fine),
          borderColor: COLORS.Moving, pointRadius: 1.5, borderWidth: 2, tension: 0.18,
        },
        {
          label: "Total paid", data: moneyLabels.map((x) => moneyByMonth.get(x).paid),
          borderColor: COLORS.Parking, pointRadius: 1.5, borderWidth: 2, tension: 0.18,
        },
      ],
    },
    options: chartOptions((value) => MONEY.format(value)),
  });

  const daily = seriesDatasets(insights.daily, "period", "violation_count", { fill: true });
  state.charts.daily = new Chart(document.querySelector("#daily-chart"), {
    type: "line",
    data: daily,
    options: chartOptions((value) => NUMBER.format(value)),
  });
  elements.dailyNote.textContent = MONTH_NAMES[selected.month - 1] + " " + selected.year;

  const hourlyRows = insights.hourly.map((row) => ({ ...row, hour: numberValue(row.hour) }));
  const hourLabels = Array.from({ length: 24 }, (_, hour) =>
    new Date(2000, 0, 1, hour).toLocaleTimeString("en-US", { hour: "numeric" })
  );
  const hourTypes = selected.types.filter((type) =>
    hourlyRows.some((row) => row.violation_type === type)
  );
  state.charts.hour = new Chart(document.querySelector("#hour-chart"), {
    type: "bar",
    data: {
      labels: hourLabels,
      datasets: hourTypes.map((type) => {
        const values = new Map(
          hourlyRows.filter((row) => row.violation_type === type)
            .map((row) => [row.hour, numberValue(row.violation_count)])
        );
        return {
          label: type,
          data: Array.from({ length: 24 }, (_, hour) => values.get(hour) ?? 0),
          backgroundColor: COLORS[type] + "c7",
          borderRadius: 2,
        };
      }),
    },
    options: chartOptions((value) => NUMBER.format(value), { stacked: true }),
  });

  const shorten = (value) => value.length > 42 ? value.slice(0, 39) + "…" : value;
  state.charts.top = new Chart(document.querySelector("#top-chart"), {
    type: "bar",
    data: {
      labels: insights.top.map((row) => shorten(String(row.violation))),
      datasets: [{
        label: "Citations",
        data: insights.top.map((row) => numberValue(row.violation_count)),
        backgroundColor: "#1d5e76c7",
        borderRadius: 3,
      }],
    },
    options: chartOptions((value) => NUMBER.format(value), { indexAxis: "y", legend: false }),
  });
}

function updatePeriodControls() {
  if (!state.manifest) return;
  const types = selectedTypes();
  const year = Number(elements.year.value);
  const ready = state.manifest.partitions.filter(
    (item) => item.status === "ready" && item.path && item.year === year
  );
  const available = new Set();
  for (let month = 1; month <= 12; month += 1) {
    const entries = ready.filter((item) => item.month === month);
    const completeForSelection = types.length
      ? types.every((type) => entries.some((item) => item.violation_type === type))
      : entries.length > 0;
    if (completeForSelection) available.add(month);
  }
  for (const option of elements.month.options) {
    option.disabled = !available.has(Number(option.value) + 1);
  }
  const selectedOption = elements.month.selectedOptions[0];
  if (selectedOption?.disabled && available.size) {
    elements.month.value = String(Math.max(...available) - 1);
  }
  updatePeriodPreview();
  updateActiveFilters();
}

function updatePeriodPreview() {
  if (!state.manifest) return;
  const selected = currentFilters();
  if (!selected.types.length) {
    elements.periodPreview.textContent = "Select at least one category.";
    return;
  }
  const entries = partitionFiles(selected);
  const rows = entries.reduce((sum, item) => sum + numberValue(item.analysis_rows), 0);
  elements.periodPreview.textContent = entries.length
    ? NUMBER.format(rows) + " records available before optional filters."
    : "No complete partition is available for this selection.";
}

function updateActiveFilters() {
  const selected = currentFilters();
  const chips = [
    MONTH_NAMES[selected.month - 1] + " " + selected.year,
    selected.types.length ? selected.types.join(" + ") : "No category",
  ];
  if (selected.agency) chips.push("Agency: " + selected.agency);
  if (selected.violation) chips.push("Violation: " + selected.violation);
  if (selected.plate) chips.push("Plate: " + selected.plate);
  if (Number.isFinite(selected.fineMin)) chips.push("Fine ≥ " + MONEY.format(selected.fineMin));
  if (Number.isFinite(selected.fineMax)) chips.push("Fine ≤ " + MONEY.format(selected.fineMax));
  elements.activeFilters.replaceChildren(...chips.map((text) => {
    const chip = document.createElement("span");
    chip.className = "filter-chip";
    chip.textContent = text;
    return chip;
  }));
}

async function refresh() {
  const requestId = ++state.requestId;
  const selected = currentFilters();
  updateActiveFilters();

  if (!selected.types.length) {
    showNotice("Select at least one violation category.", true);
    return;
  }
  if (Number.isFinite(selected.fineMin) && Number.isFinite(selected.fineMax) &&
      selected.fineMin > selected.fineMax) {
    showNotice("The minimum fine cannot exceed the maximum fine.", true);
    return;
  }

  elements.apply.disabled = true;
  showNotice("Calculating exact totals, patterns, and every matching map record…");

  try {
    const summary = await querySummary(selected);
    if (requestId !== state.requestId) return;
    renderMetrics(summary, 0);

    const trends = await queryTrends(selected);
    if (requestId !== state.requestId) return;

    const insights = await querySelectedInsights(selected);
    if (requestId !== state.requestId) return;
    renderCharts(trends, insights, selected);

    const points = await queryPoints(selected);
    if (requestId !== state.requestId) return;
    state.points = points;
    renderMetrics(summary, points.length);
    renderMap();

    const total = numberValue(summary.violation_count);
    const omitted = Math.max(0, total - points.length);
    elements.mapNote.textContent = omitted > 0
      ? "All " + NUMBER.format(points.length) + " valid locations mapped; " +
        NUMBER.format(omitted) + " filtered records lack usable coordinates."
      : "All " + NUMBER.format(points.length) + " filtered records are mapped.";
    showNotice(
      "Loaded " + NUMBER.format(points.length) + " points with no sampling. Data build: " +
      new Date(state.manifest.generated_at).toLocaleString("en-US") + "."
    );
  } catch (error) {
    console.error(error);
    showNotice(
      "The dashboard could not load this selection. Try another month or check the data build.",
      true
    );
  } finally {
    if (requestId === state.requestId) elements.apply.disabled = false;
  }
}

function setDisplay(display) {
  state.display = display;
  const heat = display === "heat";
  elements.heat.classList.toggle("active", heat);
  elements.points.classList.toggle("active", !heat);
  elements.heat.setAttribute("aria-pressed", String(heat));
  elements.points.setAttribute("aria-pressed", String(!heat));
  elements.heatControls.hidden = !heat;
  renderMap();
}

function updateHeatStyle() {
  state.heat.intensity = Number(elements.heatIntensity.value);
  state.heat.radius = Number(elements.heatRadius.value);
  state.heat.opacity = Number(elements.heatOpacity.value);
  state.heat.palette = elements.heatPalette.value;
  elements.intensityValue.textContent = state.heat.intensity.toFixed(2).replace(/0$/, "") + "×";
  elements.radiusValue.textContent = state.heat.radius + " px";
  elements.opacityValue.textContent = Math.round(state.heat.opacity * 100) + "%";
  renderMap();
}

function resetFilters() {
  const latest = latestCompletePartition();
  elements.moving.checked = true;
  elements.parking.checked = true;
  elements.year.value = String(latest?.year ?? 2026);
  elements.month.value = String((latest?.month ?? 8) - 1);
  elements.agency.value = "";
  elements.violation.value = "";
  elements.plate.value = "";
  elements.fineMin.value = "";
  elements.fineMax.value = "";
  updatePeriodControls();
  refresh();
}

async function initMap() {
  state.map = new maplibregl.Map({
    container: "map",
    style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
    center: [-77.01, 38.91],
    zoom: 11.1,
    minZoom: 9,
    maxZoom: 18,
  });
  state.map.addControl(new maplibregl.NavigationControl(), "top-right");
  await new Promise((resolve) => state.map.once("load", resolve));
  state.overlay = new deck.MapboxOverlay({ interleaved: false, layers: [], getTooltip: tooltip });
  state.map.addControl(state.overlay);
}

function bindControls() {
  elements.apply.addEventListener("click", refresh);
  elements.reset.addEventListener("click", resetFilters);
  elements.heat.addEventListener("click", () => setDisplay("heat"));
  elements.points.addEventListener("click", () => setDisplay("points"));

  for (const control of [elements.heatIntensity, elements.heatRadius, elements.heatOpacity]) {
    control.addEventListener("input", updateHeatStyle);
  }
  elements.heatPalette.addEventListener("change", updateHeatStyle);

  elements.year.addEventListener("change", updatePeriodControls);
  elements.month.addEventListener("change", () => {
    updatePeriodPreview();
    updateActiveFilters();
  });
  elements.moving.addEventListener("change", updatePeriodControls);
  elements.parking.addEventListener("change", updatePeriodControls);

  for (const input of [elements.agency, elements.violation, elements.plate,
    elements.fineMin, elements.fineMax]) {
    input.addEventListener("input", updateActiveFilters);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") refresh();
    });
  }
}

async function bootstrap() {
  showNotice("Preparing the complete dashboard dataset…");
  const response = await fetch(new URL("manifest.json", DATA_ROOT));
  if (!response.ok) throw new Error("Manifest request failed: " + response.status);
  state.manifest = await response.json();

  const latest = latestCompletePartition();
  if (latest) {
    elements.year.value = String(latest.year);
    elements.month.value = String(latest.month - 1);
  }
  updatePeriodControls();
  updateHeatStyle();

  await Promise.all([initDatabase(), initMap()]);
  await registerFile("trend_summary.parquet", state.manifest.trend_summary);
  bindControls();
  await loadFilterSuggestions();
  await refresh();
}

bootstrap().catch((error) => {
  console.error(error);
  showNotice("The dashboard data is not available yet. Check the GitHub Pages deployment.", true);
});
