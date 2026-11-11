"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import Badge from "@/shared/components/Badge";
import Pagination from "@/shared/components/Pagination";
import { cn } from "@/shared/utils/cn";
import { fmtCost } from "@/shared/utils/currency";
import { translate, getCurrentLocale } from "@/i18n/runtime";
import { fmtTokens } from "@/shared/utils/compactNumber";
import ActivityHeatmap from "./ActivityHeatmap";

function scoreVariant(score) {
  if (score >= 90) return "success";
  if (score >= 70) return "warning";
  return "error";
}

function fmtLatency(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const NODE_COLUMNS = [
  { key: "name", label: "Name", align: "left", kind: "name" },
  { key: "score", label: "Health", align: "center", kind: "badge" },
  { key: "successRate", label: "Success", align: "right", kind: "rate" },
  { key: "avgTtftMs", label: "Avg TTFT", align: "right", kind: "latency" },
  { key: "avgLatencyMs", label: "Avg Latency", align: "right", kind: "latency" },
  { key: "avgSpeed", label: "Avg Speed", align: "right", kind: "speed" },
  { key: "requests", label: "Requests", align: "right", kind: "int" },
  { key: "lastUsed", label: "Last Used", align: "right", kind: "date" },
];

// Expanded per-model drill-down under a node row: same metrics, model name
// in the first column with the provider as its subline.
const MODEL_COLUMNS = [
  { key: "model", label: "Model", align: "left", kind: "name" },
  ...NODE_COLUMNS.slice(1),
];

const ALIGN_CLASS = { left: "text-left", center: "text-center", right: "text-right" };

function fmtSpeed(tps) {
  if (tps == null || Number.isNaN(tps)) return "—";
  return `${tps.toLocaleString()} tok/s`;
}

function fmtLastUsed(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(getCurrentLocale(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Model/provider strings come from live gateway responses and custom-channel
// imports — some carry leading/embedded whitespace (observed on legacy custom
// channels like "snu/…", "85d2a64e-…:…"), which breaks column alignment in
// the tables. Normalize for display only; the raw value stays the storage key.
function cleanName(v) {
  return String(v ?? "").trim().replace(/\s+/g, " ");
}

function CellContent({ col, row, nameKey, subKey, expandable, isOpen }) {
  switch (col.kind) {
    case "name": {
      // 内部代号行（qoder 的 kmodel_latest 等）：主行显示真实产品名，原始 id
      // 降为副标签 —— 便于对账排查。无映射时二者相同，副标签不再重复。
      const raw = cleanName(row[nameKey]);
      const display = row.modelDisplay ? cleanName(row.modelDisplay) : raw;
      const showSub = subKey && row[subKey] && cleanName(row[subKey]) !== display;
      const rawSub = display !== raw && !showSub ? raw : null;
      return (
        <div className="flex min-w-0 items-start gap-1" title={display !== raw ? raw : undefined}>
          {expandable && (
            <span className="material-symbols-outlined mt-0.5 shrink-0 text-base leading-5 text-text-muted">
              {isOpen ? "expand_more" : "chevron_right"}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-text-main">{display}</div>
            {showSub && (
              <div className="truncate text-xs text-text-muted">{cleanName(row[subKey])}</div>
            )}
            {rawSub && (
              <div className="truncate text-xs font-mono text-text-muted">{rawSub}</div>
            )}
          </div>
        </div>
      );
    }
    case "badge":
      // score null = no latency sample ever measured → the row does not
      // participate in health ranking; render a plain dash, not a badge.
      if (row.score == null) return <span className="text-text-muted">—</span>;
      return <Badge variant={scoreVariant(row.score)} size="sm">{row.score}</Badge>;
    case "rate":
      return (
        <span className={cn(
          "font-mono",
          row.successRate >= 90 ? "text-success" : row.successRate >= 70 ? "text-warning" : "text-red-500"
        )}>
          {row.successRate}%
        </span>
      );
    case "latency":
      return <span className="font-mono">{fmtLatency(row[col.key])}</span>;
    case "speed":
      return <span className="font-mono">{fmtSpeed(row.avgSpeed)}</span>;
    case "int":
      return <span className="font-mono">{(row[col.key] || 0).toLocaleString()}</span>;
    case "cost":
      return <span className="font-mono">{fmtCost(row.cost)}</span>;
    case "date":
      return <span className="text-text-muted">{fmtLastUsed(row.lastUsed)}</span>;
    default:
      return String(row[col.key] ?? "—");
  }
}

CellContent.propTypes = {
  col: PropTypes.object.isRequired,
  row: PropTypes.object.isRequired,
  nameKey: PropTypes.string.isRequired,
  subKey: PropTypes.string,
  expandable: PropTypes.bool,
  isOpen: PropTypes.bool,
};

// Perf columns (TTFT / latency / speed) under an expanded node — per-axis
// visibility rules live in ExpandedModelTable.
const PERF_COLUMN_KEYS = new Set(["avgTtftMs", "avgLatencyMs", "avgSpeed"]);

// Static per-model table shown inside an expanded node row. No header row —
// the columns mirror the parent table the user just read, and no provider
// subline either: the model name alone identifies the row, the parent node
// is already stated one line up. Rows arrive pre-sorted by the caller with
// the SAME order as the parent list.
//
// Perf columns are gated per-axis, not per-node: the two data stores now
// merge per-metric, so a node can have TTFT samples but no speed (e.g.
// non-streaming meta rows + a requestDetails ring that kept TTFT). A column
// shows when the node OR any child row has samples for that axis; the
// Health column follows the latency axis (score is null without it).
function ExpandedModelTable({ rows, emptyText, parentNode }) {
  if (rows.length === 0) {
    return <p className="px-8 py-3 text-xs text-text-muted">{emptyText}</p>;
  }
  const axisPresent = {
    avgTtftMs: Boolean(parentNode?.hasTtft) || rows.some((r) => r.hasTtft),
    avgLatencyMs: Boolean(parentNode?.hasPerfData) || rows.some((r) => r.hasPerfData),
    avgSpeed: Boolean(parentNode?.hasSpeed) || rows.some((r) => r.hasSpeed),
  };
  const cols = MODEL_COLUMNS.filter((c) => {
    if (PERF_COLUMN_KEYS.has(c.key)) return axisPresent[c.key];
    if (c.key === "score") return axisPresent.avgLatencyMs;
    return true;
  });
  return (
    <table className="w-full">
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.model}
            className="border-b border-black/5 dark:border-white/5 last:border-b-0"
          >
            {cols.map((col) => (
              <td
                key={col.key}
                className={cn(
                  "p-2 pl-8 text-sm text-text-main",
                  ALIGN_CLASS[col.align],
                  // Mirror the parent table: without a width cap a long custom
                  // channel id ("85d2a64e-…:…") stretches the column and
                  // truncate never kicks in.
                  col.kind === "name" && "max-w-[240px]"
                )}
              >
                <CellContent col={col} row={row} nameKey="model" />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

ExpandedModelTable.propTypes = {
  rows: PropTypes.arrayOf(PropTypes.object).isRequired,
  emptyText: PropTypes.string.isRequired,
  parentNode: PropTypes.object,
};

// Shared comparator so expanded child rows follow the exact same order as
// the parent list — sortKey "name" maps to each level's own name field.
function sortRowsBy(list, sortKey, sortDir, nameKey) {
  const valueOf = (row) => {
    if (sortKey === "name") return cleanName(row[nameKey] || "");
    const v = row[sortKey];
    if (typeof v === "string") return v;
    return v == null ? (sortDir === "desc" ? -Infinity : Infinity) : v;
  };
  return [...list].sort((a, b) => {
    const va = valueOf(a);
    const vb = valueOf(b);
    const cmp = typeof va === "string" && typeof vb === "string" ? va.localeCompare(vb) : va - vb;
    return sortDir === "desc" ? -cmp : cmp;
  });
}

function ScoreTable({ rows, columns, nameKey, subKey, emptyText, renderExpanded, expandedEmptyText, expandedNameKey = "model" }) {
  const [sortKey, setSortKey] = useState("score");
  const [sortDir, setSortDir] = useState("desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [openKeys, setOpenKeys] = useState(() => new Set());

  const sorted = useMemo(
    () => sortRowsBy(rows, sortKey, sortDir, nameKey),
    [rows, sortKey, sortDir, nameKey]
  );

  if (rows.length === 0) {
    return <p className="py-6 text-center text-sm text-text-muted">{emptyText}</p>;
  }

  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = sorted.slice((safePage - 1) * pageSize, safePage * pageSize);

  const toggleSort = (key) => {
    setPage(1);
    if (sortKey === key) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir(key === "name" ? "asc" : "desc");
    }
  };

  const toggleOpen = (key) => {
    setOpenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px]">
          <thead>
            <tr className="border-b border-black/5 dark:border-white/5">
              {columns.map((col) => (
                <th key={col.key} className={cn("p-2 text-xs font-semibold text-text-muted", ALIGN_CLASS[col.align])}>
                  <button
                    onClick={() => toggleSort(col.key)}
                    className={cn(
                      "inline-flex items-center gap-0.5 hover:text-text-main transition-colors",
                      sortKey === col.key && "text-text-main"
                    )}
                  >
                    {translate(col.label)}
                    <span className="material-symbols-outlined text-[14px]">
                      {sortKey === col.key ? (sortDir === "desc" ? "arrow_downward" : "arrow_upward") : "unfold_more"}
                    </span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row, i) => {
              const rowKey = `${row[nameKey]}-${i}`;
              const isOpen = Boolean(renderExpanded) && openKeys.has(rowKey);
              // Children re-sort with the parent's current sortKey/sortDir so
              // both levels always read in the same order.
              const subRows = isOpen
                ? sortRowsBy(renderExpanded(row), sortKey, sortDir, expandedNameKey)
                : null;
              return (
                <Fragment key={rowKey}>
                  <tr
                    onClick={renderExpanded ? () => toggleOpen(rowKey) : undefined}
                    className={cn(
                      "border-b border-black/5 dark:border-white/5 last:border-b-0 hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors",
                      renderExpanded && "cursor-pointer select-none"
                    )}
                  >
                    {columns.map((col) => (
                      <td
                        key={col.key}
                        className={cn(
                          "p-2 text-sm text-text-main",
                          ALIGN_CLASS[col.align],
                          col.kind === "name" && "max-w-[240px]"
                        )}
                      >
                        <CellContent
                          col={col}
                          row={row}
                          nameKey={nameKey}
                          subKey={subKey}
                          expandable={Boolean(renderExpanded)}
                          isOpen={isOpen}
                        />
                      </td>
                    ))}
                  </tr>
                  {isOpen && (
                    <tr className="border-b border-black/5 dark:border-white/5 last:border-b-0">
                      <td
                        colSpan={columns.length}
                        className="p-0 bg-black/[0.02] dark:bg-white/[0.02]"
                      >
                        <ExpandedModelTable rows={subRows} emptyText={expandedEmptyText || emptyText} parentNode={row} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="border-t border-black/5 dark:border-white/5">
        <Pagination
          currentPage={safePage}
          pageSize={pageSize}
          totalItems={rows.length}
          onPageChange={setPage}
          onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
        />
      </div>
    </div>
  );
}

ScoreTable.propTypes = {
  rows: PropTypes.arrayOf(PropTypes.object).isRequired,
  columns: PropTypes.arrayOf(PropTypes.object).isRequired,
  nameKey: PropTypes.string.isRequired,
  subKey: PropTypes.string,
  emptyText: PropTypes.string.isRequired,
  renderExpanded: PropTypes.func,
  expandedEmptyText: PropTypes.string,
  expandedNameKey: PropTypes.string,
};

function LifetimeCards({ lifetime }) {
  const locale = getCurrentLocale();
  if (!lifetime) return null;
  const cards = [
    { label: "Total Requests", value: (lifetime.totalRequests || 0).toLocaleString() },
    { label: "Lifetime Tokens", value: fmtTokens(lifetime.totalTokens, locale), valueClass: "text-primary" },
    { label: "Peak Day Tokens", value: fmtTokens(lifetime.peakTokens, locale), sub: lifetime.peakDate || "", valueClass: "text-info" },
    {
      label: "Cache Hit Rate",
      value: lifetime.cacheHitRate != null ? `${lifetime.cacheHitRate}%` : "—",
      sub: translate("Only real valid data is counted"),
      valueClass: "text-success",
    },
    {
      label: "Most Used Model",
      value: lifetime.topModel?.model || "—",
      sub: lifetime.topModel
        ? `${translate("Last 7 days")} ${fmtTokens(lifetime.topModel.tokens, locale, true)}${lifetime.topModel.provider ? ` · ${lifetime.topModel.provider}` : ""}`
        : "",
      valueClass: "text-warning",
      shrink: true,
    },
  ];
  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 sm:gap-4">
      {cards.map((c) => (
        <Card key={c.label} className="flex min-w-0 flex-col gap-1 px-4 py-3" style={{ containerType: "inline-size" }}>
          <span className="truncate text-text-muted text-sm uppercase font-semibold">{translate(c.label)}</span>
          <div className="flex h-8 items-center min-w-0">
            <span
              className={cn(
                "whitespace-nowrap font-bold",
                c.shrink ? "text-[clamp(0.875rem,4.5cqw,1.5rem)] leading-none truncate" : "truncate text-2xl leading-none",
                c.valueClass
              )}
            >
              {c.value}
            </span>
          </div>
          {c.sub ? (
            <span className="truncate text-[10px] text-text-muted">{c.sub}</span>
          ) : (
            <span className="text-[10px] invisible select-none leading-normal">&nbsp;</span>
          )}
        </Card>
      ))}
    </div>
  );
}LifetimeCards.propTypes = {
  lifetime: PropTypes.object,
};

export default function UsageDashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/usage/dashboard`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!cancelled) {
          setData(json);
          setError(false);
        }
      } catch (e) {
        console.error("Failed to fetch usage dashboard:", e);
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <Card padding="md">
        <div className="flex items-center justify-center gap-2 py-8 text-text-muted">
          <span className="material-symbols-outlined animate-spin text-[20px]">progress_activity</span>
          {translate("Loading dashboard...")}
        </div>
      </Card>
    );
  }

  if (error || !data) {
    return (
      <Card padding="md">
        <p className="py-6 text-center text-sm text-text-muted">{translate("Failed to load usage dashboard")}</p>
      </Card>
    );
  }

  // Node Health lists only nodes with a real health score — a node with zero
  // latency observations (score null, e.g. a purely gateway-synced channel
  // like bai) has no ranking signal at all and stays off the list. The API
  // still returns those rows (traffic/success stats remain queryable); this
  // is a display-level filter.
  const nodes = (data.nodes || []).filter((n) => n.score != null);
  const daily = data.daily || [];

  return (
    <>
      <LifetimeCards lifetime={data.lifetime} />
      <Card title={translate("Activity Heatmap")} icon="calendar_month" padding="md">
        {daily.length === 0 ? (
          <p className="py-6 text-center text-sm text-text-muted">{translate("No activity in the selected period")}</p>
        ) : (
          <ActivityHeatmap daily={daily} days={365} currentStreak={data.lifetime?.currentStreak} />
        )}
      </Card>
      <Card title={translate("Node Health")} icon="dns" padding="md">
        <p className="mb-2 text-xs text-text-muted">{translate("Last 7 days (≥50 real requests)")}</p>
        <ScoreTable
          rows={nodes}
          columns={NODE_COLUMNS}
          nameKey="name"
          emptyText={translate("No nodes with 50+ requests in this period")}
          renderExpanded={(node) =>
            (data.models || []).filter((m) => m.provider === node.provider)
          }
          expandedEmptyText={translate("No models with 10+ requests under this node")}
        />
      </Card>
    </>
  );
}
