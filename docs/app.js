import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/+esm";

const DATA_ROOT = new URL("data/", window.location.href);
const NUMBER = new Intl.NumberFormat("en-US");
const MONEY = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const COLORS = {
  moving: [218, 100, 47, 190],
  parking: [29, 94, 118, 175],
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
  countChart: null,
  moneyChart: null,
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
  count: document.querySelector("#metric-count"),
  fines: document.querySelector("#metric-fines"),
  paid: document.querySelector("#metric-paid"),
  pointCount: document.querySelector("#metric-points"),
  mapNote: document.querySelector("#map-note"),
  heat: document.querySelector("#show-heat"),
  points: document.querySelector("#show-points"),
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
  const fineMin =
    elements.fineMin.value === "" ? null : Number(elements.fineMin.value);
  const fineMax =
    elements.fineMax.value === "" ? null : Number(elements.fineMax.value);
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
      "violation_type IN (" +
        selected.types.map(sqlString).join(", ") +
        ")"
    );
  }
  if (selected.agency) {
    clauses.push(
      "strpos(lower(coalesce(agency, '')), lower(" +
        sqlString(selected.agency) +
        ")) > 0"
    );
  }
  if (selected.violation) {
    clauses.push(
      "strpos(lower(coalesce(violation, '')), lower(" +
        sqlString(selected.violation) +
        ")) > 0"
    );
  }
  if (selected.plate) {
    clauses.push(
      "upper(coalesce(plate_state, '')) = " + sqlString(selected.plate)
    );
  }
  if (Number.isFinite(selected.fineMin)) {
    clauses.push("fine_amount >= " + selected.fineMin);
  }
  if (Number.isFinite(selected.fineMax)) {
    clauses.push("fine_amount <= " + selected.fineMax);
  }
  return clauses.length ? clauses.join(" AND ") : "TRUE";
}

async function initDatabase() {
  const bundles = duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle(bundles);
  const workerCode = 'importScripts("' + bundle.mainWorker + '");';
  const workerUrl = URL.createObjectURL(
    new Blob([workerCode], { type: "text/javascript" })
  );
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
    )) {
      continue;
    }

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

async function querySummary(selected) {
  const month = String(selected.month).padStart(2, "0");
  const where =
    filterSql(selected, true) +
    " AND year_month = " +
    sqlString(selected.year + "-" + month);
  const sql = [
    "SELECT",
    "  coalesce(sum(violation_count), 0) AS violation_count,",
    "  coalesce(sum(fine_total), 0) AS fine_total,",
    "  coalesce(sum(paid_total), 0) AS paid_total",
    "FROM read_parquet('trend_summary.parquet')",
    "WHERE " + where,
  ].join("\n");
  const result = await state.connection.query(sql);
  return tableRows(result)[0];
}

async function queryTrends(selected) {
  const sql = [
    "SELECT",
    "  year_month,",
    "  sum(violation_count) AS violation_count,",
    "  sum(fine_total) AS fine_total,",
    "  sum(paid_total) AS paid_total",
    "FROM read_parquet('trend_summary.parquet')",
    "WHERE " + filterSql(selected, true),
    "GROUP BY year_month",
    "ORDER BY year_month",
  ].join("\n");
  const result = await state.connection.query(sql);
  return tableRows(result);
}

async function queryPoints(selected) {
  const partitions = partitionFiles(selected);
  if (!partitions.length) return [];

  const aliases = [];
  for (const item of partitions) {
    const alias =
      "points_" +
      item.year +
      "_" +
      String(item.month).padStart(2, "0") +
      "_" +
      item.violation_type.toLowerCase() +
      ".parquet";
    await registerFile(alias, item.path);
    aliases.push(sqlString(alias));
  }

  const sql = [
    "SELECT",
    "  latitude, longitude, issue_date, issue_hour, agency, violation,",
    "  plate_state, fine_amount, total_paid, location, violation_type",
    "FROM read_parquet([" + aliases.join(", ") + "])",
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
      '<div class="popup-title">' +
      escapeHtml(object.violation) +
      "</div>" +
      '<div class="popup-row">' +
      escapeHtml(object.location) +
      "</div>" +
      '<div class="popup-row">' +
      escapeHtml(object.agency) +
      " · " +
      escapeHtml(object.violationType) +
      "</div>" +
      '<div class="popup-row">' +
      escapeHtml(date) +
      " · " +
      MONEY.format(object.fineAmount) +
      " fine · " +
      MONEY.format(object.totalPaid) +
      " paid</div>" +
      '<div class="popup-row">Plate state: ' +
      escapeHtml(object.plateState) +
      "</div>",
  };
}

function renderMap() {
  if (!state.overlay) return;
  const common = {
    data: state.points,
    getPosition: (item) => [item.longitude, item.latitude],
  };
  const layer =
    state.display === "heat"
      ? new deck.HeatmapLayer({
          id: "violations-heat",
          ...common,
          getWeight: 1,
          radiusPixels: 34,
          intensity: 1,
          threshold: 0.03,
          colorRange: [
            [247, 244, 232, 0],
            [180, 211, 215, 120],
            [63, 130, 145, 180],
            [218, 100, 47, 220],
            [109, 28, 20, 255],
          ],
        })
      : new deck.ScatterplotLayer({
          id: "violations-points",
          ...common,
          getFillColor: (item) =>
            item.violationType === "Moving"
              ? COLORS.moving
              : COLORS.parking,
          getRadius: 3,
          radiusUnits: "pixels",
          radiusMinPixels: 1.5,
          radiusMaxPixels: 6,
          pickable: true,
          autoHighlight: true,
        });

  state.overlay.setProps({
    layers: [layer],
    getTooltip: tooltip,
  });
}

function renderMetrics(summary, pointCount) {
  elements.count.textContent = NUMBER.format(
    numberValue(summary.violation_count)
  );
  elements.fines.textContent = MONEY.format(numberValue(summary.fine_total));
  elements.paid.textContent = MONEY.format(numberValue(summary.paid_total));
  elements.pointCount.textContent = NUMBER.format(pointCount);
}

function chartOptions(yFormatter) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: {
        labels: {
          color: "#34444a",
          font: { family: "Public Sans" },
          usePointStyle: true,
        },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: { maxRotation: 45, minRotation: 0, color: "#657278" },
      },
      y: {
        beginAtZero: true,
        grid: { color: "rgba(101,114,120,0.16)" },
        ticks: {
          color: "#657278",
          callback: yFormatter,
        },
      },
    },
  };
}

function renderCharts(rows) {
  const labels = rows.map((row) => row.year_month);
  const counts = rows.map((row) => numberValue(row.violation_count));
  const fines = rows.map((row) => numberValue(row.fine_total));
  const paid = rows.map((row) => numberValue(row.paid_total));

  state.countChart?.destroy();
  state.moneyChart?.destroy();

  state.countChart = new Chart(document.querySelector("#count-chart"), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Violations",
          data: counts,
          borderColor: "#1d5e76",
          backgroundColor: "rgba(29,94,118,0.12)",
          pointRadius: 2,
          pointHoverRadius: 5,
          borderWidth: 2,
          tension: 0.18,
          fill: true,
        },
      ],
    },
    options: chartOptions((value) => NUMBER.format(value)),
  });

  state.moneyChart = new Chart(document.querySelector("#money-chart"), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Fines issued",
          data: fines,
          borderColor: "#da642f",
          pointRadius: 2,
          borderWidth: 2,
          tension: 0.18,
        },
        {
          label: "Total paid",
          data: paid,
          borderColor: "#1d5e76",
          pointRadius: 2,
          borderWidth: 2,
          tension: 0.18,
        },
      ],
    },
    options: chartOptions((value) => MONEY.format(value)),
  });
}

async function refresh() {
  const requestId = ++state.requestId;
  const selected = currentFilters();

  if (!selected.types.length) {
    showNotice("Select at least one violation category.", true);
    return;
  }
  if (
    Number.isFinite(selected.fineMin) &&
    Number.isFinite(selected.fineMax) &&
    selected.fineMin > selected.fineMax
  ) {
    showNotice("The minimum fine cannot exceed the maximum fine.", true);
    return;
  }

  elements.apply.disabled = true;
  showNotice("Calculating exact totals and loading every matching map record…");

  try {
    const summary = await querySummary(selected);
    if (requestId !== state.requestId) return;
    renderMetrics(summary, 0);

    const trends = await queryTrends(selected);
    if (requestId !== state.requestId) return;
    renderCharts(trends);

    const points = await queryPoints(selected);
    if (requestId !== state.requestId) return;
    state.points = points;
    renderMetrics(summary, points.length);
    renderMap();

    const total = numberValue(summary.violation_count);
    const omitted = Math.max(0, total - points.length);
    elements.mapNote.textContent =
      omitted > 0
        ? "All " +
          NUMBER.format(points.length) +
          " records with valid D.C. coordinates are mapped; " +
          NUMBER.format(omitted) +
          " filtered records lack usable coordinates."
        : "All " + NUMBER.format(points.length) + " filtered records are mapped.";
    showNotice(
      "Loaded " +
        NUMBER.format(points.length) +
        " points with no sampling. Data build: " +
        new Date(state.manifest.generated_at).toLocaleString("en-US") +
        "."
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
  state.overlay = new deck.MapboxOverlay({
    interleaved: false,
    layers: [],
    getTooltip: tooltip,
  });
  state.map.addControl(state.overlay);
}

async function bootstrap() {
  showNotice("Preparing the complete dashboard dataset…");
  const response = await fetch(new URL("manifest.json", DATA_ROOT));
  if (!response.ok) {
    throw new Error("Manifest request failed: " + response.status);
  }
  state.manifest = await response.json();

  const latest = latestCompletePartition();
  if (latest) {
    elements.year.value = String(latest.year);
    elements.month.value = String(latest.month - 1);
  }

  await Promise.all([initDatabase(), initMap()]);
  await registerFile("trend_summary.parquet", state.manifest.trend_summary);

  elements.apply.addEventListener("click", refresh);
  elements.reset.addEventListener("click", resetFilters);
  elements.heat.addEventListener("click", () => setDisplay("heat"));
  elements.points.addEventListener("click", () => setDisplay("points"));

  await refresh();
}

bootstrap().catch((error) => {
  console.error(error);
  showNotice(
    "The dashboard data is not available yet. Check the GitHub Pages deployment.",
    true
  );
});
