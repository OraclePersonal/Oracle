/**
 * Multi-panel SVG report for oracle-memory benchmark results.
 *
 * Panels:
 *   - Quality: recall@k, MRR, temporal accuracy (horizontal bars, 0-100% axis)
 *   - Latency: remember / search / forget / consolidate (horizontal bars, ms scale)
 *   - Scale: write + search latency across memory sizes
 *   - Config: comparison bars when --compare was used
 */

export interface PhaseResult {
  phase: string;
  config: string;
  metrics: Record<string, string | number>;
}

interface Meta {
  vectors: string;
  llm: string;
  elapsed?: string;
}

const esc = (s: string | number): string =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ── Layout helpers ─────────────────────────────────────────────────────

interface Panel {
  title: string;
  rows: { label: string; value: string; pass?: boolean; pct?: number }[];
  /** Label for the axis (shown after the title or as axis label) */
  axisLabel?: string;
}

const W = 820;
const padL = 200;
const padR = 140;
const top = 96;
const rowH = 36;
const barH = 14;
const gap = rowH - barH;
const plotW = W - padL - padR;

function x(value: number, max: number): number {
  return padL + Math.max(0, Math.min(1, value / max)) * plotW;
}

function renderPanel(panel: Panel, offsetY: number): string {
  const { rows, title } = panel;
  const H = top + rows.length * rowH + 40;
  const localTop = 48;

  // Determine max for bar scaling: pick the best unit from values
  const numValues = rows
    .map((r) => {
      const v = parseFloat(r.value);
      return isNaN(v) ? 0 : v;
    });
  const maxVal = Math.max(...numValues, 1);

  const bars = rows
    .map((r, i) => {
      const cy = localTop + i * rowH + gap / 2;
      const raw = parseFloat(r.value);
      const v = isNaN(raw) ? 0 : raw;
      const bw = Math.max(2, x(v, maxVal) - padL);
      const pass = r.pass;
      const cls = pass === undefined ? "neutral" : pass ? "good" : "crit";
      // For percentage metrics, show at / of max
      return `
    <g class="row">
      <text class="lbl" x="${padL - 14}" y="${cy + barH / 2 + 4}" text-anchor="end">${esc(r.label)}</text>
      <rect class="track" x="${padL}" y="${cy}" width="${plotW}" height="${barH}" rx="4"/>
      <rect class="bar ${cls}" x="${padL}" y="${cy}" width="${bw.toFixed(1)}" height="${barH}" rx="4"/>
      <text class="val ${cls}" x="${(padL + bw + 8).toFixed(1)}" y="${cy + barH / 2 + 4}">${r.pass !== undefined ? (r.pass ? "✓" : "✗") : ""} ${esc(r.value)}</text>
    </g>`;
    })
    .join("");

  // Axis ticks
  const tickCount = 5;
  const ticks = Array.from({ length: tickCount }, (_, i) => {
    const val = (maxVal / (tickCount - 1)) * i;
    const tx = x(val, maxVal).toFixed(1);
    const label = panel.axisLabel === "%" ? `${Math.round(val)}%` : val < 1 ? val.toFixed(2) : val.toFixed(0);
    return `<line class="grid" x1="${tx}" y1="${localTop - 8}" x2="${tx}" y2="${localTop + rows.length * rowH}"/><text class="tick" x="${tx}" y="${localTop + rows.length * rowH + 20}" text-anchor="middle">${label}</text>`;
  }).join("");

  return `
  <g transform="translate(0, ${offsetY})">
    <rect class="panel-bg" x="0" y="0" width="${W}" height="${H}" rx="8"/>
    <text class="panel-title" x="20" y="30">${esc(title)}</text>
    ${ticks}
    ${bars}
  </g>`;
}

// ── Assemble panels from phase results ────────────────────────────────

function buildPanels(results: PhaseResult[], _meta: Meta): Panel[] {
  const panels: Panel[] = [];

  // Panel 1: Quality
  const q = results.find((r) => r.phase === "quality");
  if (q) {
    const recall = +(q.metrics.recallAtK as number);
    const mrr = q.metrics.mrr as number;
    const temporal = +(q.metrics.temporalAcc as number);
    panels.push({
      title: `Retrieval Quality · ${q.config}`,
      axisLabel: "%",
      rows: [
        { label: `recall@5`, value: `${(recall * 100).toFixed(1)}%`, pass: recall >= 0.75, pct: recall },
        { label: "MRR", value: mrr.toFixed(3), pass: mrr >= 0.7, pct: mrr },
        { label: "temporal accuracy", value: `${(temporal * 100).toFixed(1)}%`, pass: temporal >= 1.0, pct: temporal },
      ],
    });
  }

  // Panel 2: Latency
  const l = results.find((r) => r.phase === "latency");
  if (l) {
    panels.push({
      title: `Operation Latency · ${l.config}`,
      rows: [
        { label: "remember (avg)", value: l.metrics.rememberAvg as string },
        { label: "remember (min)", value: l.metrics.rememberMin as string },
        { label: "remember (max)", value: l.metrics.rememberMax as string },
        { label: "search (avg)", value: l.metrics.searchAvg as string },
        { label: "search (min)", value: l.metrics.searchMin as string },
        { label: "search (max)", value: l.metrics.searchMax as string },
        { label: "forget (avg)", value: l.metrics.forgetAvg as string },
        { label: "consolidate", value: l.metrics.consolidate as string },
      ],
    });
  }

  // Panel 3: Scale
  const scaleResults = results.filter((r) => r.phase.startsWith("scale@"));
  if (scaleResults.length > 0) {
    const rows = scaleResults.map((r) => ({
      label: `${r.phase.replace("scale@", "")} mems`,
      value: `${r.metrics.writeAvg} / ${r.metrics.searchAvg}`,
    }));
    // Add sub-rows for write throughput
    const tpRows = scaleResults.map((r) => ({
      label: `  throughput`,
      value: r.metrics.writeThroughput as string,
    }));
    const storageRows = scaleResults.map((r) => ({
      label: `  storage`,
      value: r.metrics.storage as string,
    }));
    panels.push({
      title: `Scale Stress · ${scaleResults[0].config}`,
      rows: [
        ...rows,
        ...tpRows,
        ...storageRows,
      ],
    });
  }

  // Panel 4: Config Comparison
  const cmpResults = results.filter((r) => r.phase === "compare");
  if (cmpResults.length > 0) {
    const rows = cmpResults.flatMap((r) => [
      { label: `${r.config} · write`, value: r.metrics.writeAvg as string },
      { label: `${r.config} · search`, value: r.metrics.searchAvg as string },
      { label: `${r.config} · storage`, value: r.metrics.storage as string },
    ]);
    panels.push({
      title: "Config Comparison",
      rows,
    });
  }

  return panels;
}

// ── Main render function ──────────────────────────────────────────────

export function renderBenchSvg(results: PhaseResult[], meta: Meta): string {
  const panels = buildPanels(results, meta);
  const panelHeights = panels.map((p) => 48 + p.rows.length * rowH + 50);
  const totalPanelsHeight = panelHeights.reduce((a, b) => a + b, 0);
  const gap = 16;
  const totalH = panels.length > 0 ? totalPanelsHeight + (panels.length - 1) * gap + 20 : 200;
  const sub = `vectors: ${esc(meta.vectors)}  ·  llm detectors: ${esc(meta.llm)}${meta.elapsed ? `  ·  elapsed: ${esc(meta.elapsed)}` : ""}`;

  let y = 0;
  const renderedPanels = panels.map((p, i) => {
    const html = renderPanel(p, y);
    y += panelHeights[i] + gap;
    return html;
  }).join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${totalH}" width="${W}" height="${totalH}" font-family="ui-sans-serif, -apple-system, Segoe UI, Roboto, sans-serif">
  <style>
    :root { --surface:#ffffff; --ink:#1f2933; --muted:#6b7280; --track:#eceef1; --grid:#e5e7eb; --good:#159a6b; --crit:#d64545; --neutral:#3b82f6; --panel-bg:#f9fafb; }
    .bg{fill:var(--surface)}
    .title{fill:var(--ink);font-size:19px;font-weight:700}
    .subtitle{fill:var(--muted);font-size:12px}
    .panel-title{fill:var(--ink);font-size:14px;font-weight:700}
    .panel-bg{fill:var(--panel-bg);stroke:var(--grid);stroke-width:1}
    .lbl{fill:var(--ink);font-size:12px;font-weight:600}
    .tick{fill:var(--muted);font-size:10px}
    .val{font-size:12px;font-weight:700}
    .val.good{fill:var(--good)} .val.crit{fill:var(--crit)} .val.neutral{fill:var(--neutral)}
    .track{fill:var(--track)}
    .bar.good{fill:var(--good)} .bar.crit{fill:var(--crit)} .bar.neutral{fill:var(--neutral)}
    .grid{stroke:var(--grid);stroke-width:1}
    @media (prefers-color-scheme: dark){
      :root{ --surface:#0f1419; --ink:#e6e8eb; --muted:#9aa4b2; --track:#232a33; --grid:#2b323c; --good:#34d399; --crit:#f87171; --neutral:#60a5fa; --panel-bg:#151c25; }
    }
  </style>
  <rect class="bg" x="0" y="0" width="${W}" height="${totalH}"/>
  <text class="title" x="20" y="40">oracle-memory · eval benchmark</text>
  <text class="subtitle" x="20" y="60">${sub}</text>
  ${renderedPanels}
</svg>`;
}
