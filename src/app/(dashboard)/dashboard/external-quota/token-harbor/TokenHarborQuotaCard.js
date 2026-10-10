"use client";

import { useState, useEffect } from "react";
import Card from "@/shared/components/Card";
import Badge from "@/shared/components/Badge";
import { translate } from "@/i18n/runtime";

export default function TokenHarborQuotaCard({ onRefresh }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [requiresAuth, setRequiresAuth] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/external-quota/token-harbor");
      const result = await response.json();

      if (result.success) {
        setData(result.data);
        setRequiresAuth(false);
        if (onRefresh) onRefresh();
      } else {
        setError(result.message || translate("Failed to fetch quota"));
        setRequiresAuth(result.requiresAuth || false);
      }
    } catch (err) {
      setError(err.message || translate("Network error"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    // Refresh every 5 minutes
    const interval = setInterval(fetchData, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  const handleRefresh = () => {
    fetchData();
  };

  if (requiresAuth && !loading) {
    return (
      <Card padding="md" className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className="size-10 rounded-lg flex items-center justify-center p-1.5"
              style={{ backgroundColor: "#6366f115" }}
            >
              <span className="text-2xl">🏻</span>
            </div>
            <div>
              <h3 className="font-semibold text-text">Token Harbor</h3>
              <Badge variant="default" size="xs">
                Free Access
              </Badge>
            </div>
          </div>
          <button
            onClick={handleRefresh}
            disabled={loading}
            className="p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
          >
            <span
              className={`material-symbols-outlined text-[20px] text-text-muted ${
                loading ? "animate-spin" : ""
              }`}
            >
              refresh
            </span>
          </button>
        </div>

        <div className="p-4 rounded-lg bg-orange-500/10 border border-orange-500/20">
          <div className="flex items-start gap-2">
            <span className="material-symbols-outlined text-orange-500 text-[20px] mt-0.5">
              login
            </span>
            <div>
              <p className="text-sm font-medium text-orange-600 dark:text-orange-400 mb-1">
                {translate("Authentication required")}
              </p>
              <p className="text-xs text-orange-700 dark:text-orange-300/80">
                {translate(
                  "Please log in to https://tokenharbor.ai/dashboard using the browser below to save your session cookies. Then click refresh to display your quota."
                )}
              </p>
            </div>
          </div>

          <a
            href="https://tokenharbor.ai/dashboard"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex items-center gap-2 text-sm text-orange-600 dark:text-orange-400 hover:underline"
          >
            <span className="material-symbols-outlined text-sm">open_in_new</span>
            Open Token Harbor Dashboard
          </a>
        </div>
      </Card>
    );
  }

  return (
    <Card padding="md" className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div
            className="size-10 rounded-lg flex items-center justify-center p-1.5"
            style={{ backgroundColor: "#6366f115" }}
          >
            <span className="text-2xl">🏻</span>
          </div>

          <div>
            <h3 className="font-semibold text-text">Token Harbor</h3>
            <Badge variant="primary" size="xs">
              Free Tier
            </Badge>
          </div>
        </div>

        {/* Refresh Button */}
        <button
          onClick={handleRefresh}
          disabled={loading}
          className="p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
          title={translate("Refresh quota")}
        >
          <span
            className={`material-symbols-outlined text-[20px] text-text-muted ${
              loading ? "animate-spin" : ""
            }`}
          >
            refresh
          </span>
        </button>
      </div>

      {/* Loading State */}
      {loading && (
        <div className="space-y-4">
          <div className="space-y-2">
            <div className="h-4 bg-black/5 dark:bg-white/5 rounded animate-pulse" />
            <div className="h-2 bg-black/5 dark:bg-white/5 rounded animate-pulse" />
          </div>
        </div>
      )}

      {/* Error State */}
      {!loading && error && !requiresAuth && (
        <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/20">
          <div className="flex items-start gap-2">
            <span className="material-symbols-outlined text-red-500 text-[20px]">
              error
            </span>
            <p className="text-sm text-red-600 dark:text-red-400">{translate(error)}</p>
          </div>
        </div>
      )}

      {/* Quota Data */}
      {!loading && data?.success && (
        <div className="space-y-4">
          {/* Free Allowance Progress */}
          {data.freeAllowanceUsed !== undefined && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="font-semibold text-text">
                  {translate("Free allowance used")}
                </span>
                <div className="flex items-center gap-1.5">
                  <span className="text-xs">
                    {data.freeAllowanceRemaining}% remaining
                  </span>
                  <span
                    className={`material-symbols-outlined text-[16px] ${
                      data.freeAllowanceRemaining > 50
                        ? "text-green-500"
                        : data.freeAllowanceRemaining > 20
                          ? "text-yellow-500"
                          : "text-red-500"
                    }`}
                  >
                    {data.freeAllowanceRemaining > 50
                      ? "check_circle"
                      : data.freeAllowanceRemaining > 20
                        ? "warning"
                        : "error"}
                  </span>
                </div>
              </div>

              <div className="h-3 rounded-full overflow-hidden bg-gray-200 dark:bg-gray-700">
                <div
                  className="h-full transition-all duration-300"
                  style={{
                    width: `${data.freeAllowanceUsed}%`,
                    backgroundColor:
                      data.freeAllowanceRemaining > 50
                        ? "#22c55e"
                        : data.freeAllowanceRemaining > 20
                          ? "#eab308"
                          : "#ef4444",
                  }}
                />
              </div>

              <div className="flex items-center justify-between text-xs text-text-muted/70">
                <span>{data.freeAllowanceUsed}% used</span>
                {data.resetTimeDisplay && (
                  <div className="flex items-center gap-1">
                    <span className="material-symbols-outlined text-sm">
                      schedule
                    </span>
                    <span className="font-medium">
                      Reset in {data.resetTimeDisplay}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Upgrade Info */}
          {data.upgradePrice && (
            <div className="p-3 rounded-lg bg-blue-500/5 border border-blue-500/20">
              <p className="text-xs text-text-muted mb-1">
                {translate("Upgrade option")}
              </p>
              <p className="text-sm font-medium text-blue-600 dark:text-blue-400">
                Explore Passes: ${data.upgradePrice}/month (first month)
              </p>
            </div>
          )}

          {/* Last Updated */}
          <div className="pt-2 border-t border-black/5 dark:border-white/5">
            <p className="text-xs text-text-muted/50 text-center">
              {translate("Last updated")}:{" "}
              {new Date(data.timestamp).toLocaleString()}
            </p>
          </div>
        </div>
      )}

      {/* Empty State */}
      {!loading && data && !data.success && !requiresAuth && (
        <div className="text-center py-8 text-text-muted">
          <span className="material-symbols-outlined text-[48px] opacity-20">
            data_usage
          </span>
          <p className="text-sm mt-2">
            {translate("No quota data available")}
          </p>
        </div>
      )}
    </Card>
  );
}
