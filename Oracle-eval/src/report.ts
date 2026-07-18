/**
 * SVG bar-chart report generator for oracle-eval benchmarks.
 *
 * Produces a single SVG file with horizontal bar-chart panels:
 *   - Memory Quality: recall@k, MRR, temporal accuracy (0-100% axis)
 *   - Messages Throughput: send/poll latency (ms scale)
 *   - Optional additional panels from custom PhaseResults
 *
 * Follows the same visual conventions as oracle-memory's bench/svg.ts.
 */

import type { PhaseResult, BenchMeta } from "./types.js";

// ── Constants ─────────────────────────────────────────────────────────────

const SVG_WIDTH = 820;
const PAD_LEFT = 200;
const PAD_RIGHT = 140;
const PANEL_TOP = 48;
const ROW_HEIGHT = 36;
const BAR_HEIGHT = 14;
const GAP = ROW_HEIGHT - BAR_HEIGHT;
const PLOT_WIDTH = SVG_WIDTH - PAD_LEFT - PAD_RIGHT;
const PANEL_GAP = 16;

// ── Helpers ───────────────────────────────────────────────────────────────

function esc(s: string | number): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface BarRow {
  label: string;
  value: string;
  pass?: boolean;
  pct?: number;
}

interface PanelDef {
  title: string;
  rows: BarRow[];
  axisLabel?: string;
}

function barX(value: number, max: number): number {
  if (!isFinite(value) || !isFinite(max) || max <= 0) return PAD_LEFT;
  return PAD_LEFT + Math.max(0, Math.min(1, value / max)) * PLOT_WIDTH;
}

function renderPanel(panel: PanelDef, offsetY: number): string {
  const { rows, title } = panel;
  const panelH = PANEL_TOP + rows.length * ROW_HEIGHT + 40;

  const numValues = rows.map((r) => {
    const v = parseFloat(r.value);
    return isNaN(v) || !isFinite(v) ? 0 : v;
  });
  const maxVal = Math.max(...numValues, 1);

  const bars = rows
    .map((r, i) => {
      const cy = PANEL_TOP + i * ROW_HEIGHT + GAP / 2;
      const raw = parseFloat(r.value);
      const v = isNaN(raw) ? 0 : raw;
      const bw = Math.max(2, barX(v, maxVal) - PAD_LEFT);
      const cls = r.pass === undefined ? "neutral" : r.pass ? "good" : "crit";
      const passMark = r.pass !== undefined ? (r.pass ? "✓" : "✗") : "";
      const valText = r.pct !== undefined ? `${(r.pct * 100).toFixed(1)}%` : r.value;
      return `
    <g class="row">
      <text class="lbl" x="${PAD_LEFT - 14}" y="${cy + BAR_HEIGHT / 2 + 4}" text-anchor="end">${esc(r.label)}</text>
      <rect class="track" x="${PAD_LEFT}" y="${cy}" width="${PLOT_WIDTH}" height="${BAR_HEIGHT}" rx="4"/>
      <rect class="bar ${cls}" x="${PAD_LEFT}" y="${cy}" width="${bw.toFixed(1)}" height="${BAR_HEIGHT}" rx="4"/>
      <text class="val ${cls}" x="${(PAD_LEFT + bw + 8).toFixed(1)}" y="${cy + BAR_HEIGHT / 2 + 4}">${passMark} ${esc(valText)}</text>
    </g>`;
    })
    .join("");

  const tickCount = 5;
  const ticks = Array.from({ length: tickCount }, (_, i) => {
    const val = (maxVal / (tickCount - 1)) * i;
    const tx = barX(val, maxVal).toFixed(1);
    const label =
      panel.axisLabel === "%"
        ? `${Math.round(val)}%`
        : val < 1
          ? val.toFixed(2)
          : val.toFixed(0);
    return `<line class="grid" x1="${tx}" y1="${PANEL_TOP - 8}" x2="${tx}" y2="${PANEL_TOP + rows.length * ROW_HEIGHT}"/><text class="tick" x="${tx}" y="${PANEL_TOP + rows.length * ROW_HEIGHT + 20}" text-anchor="middle">${label}</text>`;
  }).join("");

  return `
  <g transform="translate(0, ${offsetY})">
    <rect class="panel-bg" x="0" y="0" width="${SVG_WIDTH}" height="${panelH}" rx="8"/>
    <text class="panel-title" x="20" y="30">${esc(title)}</text>
    ${ticks}
    ${bars}
  </g>`;
}

// ── Panel Builder ─────────────────────────────────────────────────────────

function buildPanels(results: PhaseResult[]): PanelDef[] {
  const panels: PanelDef[] = [];

  // Panel: Memory Quality
  const q = results.find((r) => r.phase === "memory_quality");
  if (q) {
    const recall = +(q.metrics.recallAtK as number);
    const mrrVal = q.metrics.mrr as number;
    const temporal = +(q.metrics.temporalAcc as number);
    panels.push({
      title: `Memory Retrieval Quality · ${q.config}`,
      axisLabel: "%",
      rows: [
        { label: "recall@k", value: `${(recall * 100).toFixed(1)}%`, pass: recall >= 0.75, pct: recall },
        { label: "MRR", value: mrrVal.toFixed(3), pass: mrrVal >= 0.7, pct: mrrVal },
        { label: "temporal accuracy", value: `${(temporal * 100).toFixed(1)}%`, pass: temporal >= 0.8, pct: temporal },
      ],
    });
  }

  // Panel: Messages Throughput
  const m = results.find((r) => r.phase === "messages_throughput");
  if (m) {
    panels.push({
      title: `Messages Throughput · ${m.config}`,
      rows: [
        { label: "send (avg)", value: m.metrics.sendAvg as string },
        { label: "send (min)", value: m.metrics.sendMin as string },
        { label: "send (max)", value: m.metrics.sendMax as string },
        { label: "poll (avg)", value: m.metrics.pollAvg as string },
        { label: "poll (min)", value: m.metrics.pollMin as string },
        { label: "poll (max)", value: m.metrics.pollMax as string },
        { label: "throughput", value: m.metrics.throughput as string },
      ],
    });
  }

  // Panel: Orchestration (if present)
  const o = results.find((r) => r.phase === "orchestration");
  if (o) {
    panels.push({
      title: `Orchestration Roundtrip · ${o.config}`,
      rows: [
        { label: "roundtrip (avg)", value: o.metrics.roundtripAvg as string },
        { label: "roundtrip (min)", value: o.metrics.roundtripMin as string },
        { label: "roundtrip (max)", value: o.metrics.roundtripMax as string },
        { label: "tool calls", value: String(o.metrics.toolCalls) },
        { label: "errors", value: String(o.metrics.errors), pass: (o.metrics.errors as number) === 0 },
      ],
    });
  }

  // Panel: Scale (if memory scale tests were run)
  const scaleResults = results.filter((r) => r.phase.startsWith("scale@"));
  if (scaleResults.length > 0) {
    const rows = scaleResults.map((r) => ({
      label: `${r.phase.replace("scale@", "")} memories`,
      value: r.metrics.writeAvg as string,
    }));
    panels.push({
      title: `Scale Stress`,
      rows,
    });
  }

  return panels;
}

// ── Main Render ───────────────────────────────────────────────────────────

/**
 * Render benchmark results as an SVG bar-chart report.
 *
 * @param results - Array of phase results from benchmark runs
 * @param meta - Metadata describing the benchmark target and config
 * @returns SVG string
 */
export function renderBenchSvg(results: PhaseResult[], meta: BenchMeta): string {
  const panels = buildPanels(results);
  const panelHeights = panels.map((p) => PANEL_TOP + p.rows.length * ROW_HEIGHT + 50);
  const sumPanelHeight = panelHeights.reduce((a, b) => a + b, 0);
  const totalHeight = panels.length > 0
    ? sumPanelHeight + (panels.length - 1) * PANEL_GAP + 20
    : 200;

  const subtitle = `target: ${esc(meta.target)}  ·  v${esc(meta.version)}${meta.elapsed ? `  ·  elapsed: ${esc(meta.elapsed)}` : ""}${meta.timestamp ? `  ·  ${esc(meta.timestamp)}` : ""}`;

  let y = 0;
  const renderedPanels = panels.map((p, i) => {
    const html = renderPanel(p, y);
    y += panelHeights[i] + PANEL_GAP;
    return html;
  }).join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SVG_WIDTH} ${totalHeight}" width="${SVG_WIDTH}" height="${totalHeight}" font-family="ui-sans-serif, -apple-system, Segoe UI, Roboto, sans-serif">
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
  <rect class="bg" x="0" y="0" width="${SVG_WIDTH}" height="${totalHeight}"/>
  <text class="title" x="20" y="40">oracle-eval · benchmark report</text>
  <text class="subtitle" x="20" y="60">${subtitle}</text>
  ${renderedPanels}
</svg>`;
}
