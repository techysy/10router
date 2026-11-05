"use client";

import { useParams, notFound, useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Card, Badge, Button, Toggle, AddCustomEmbeddingModal } from "@/shared/components";
import ProviderIcon from "@/shared/components/ProviderIcon";
import DraggableCard from "@/shared/components/DraggableCard";
import { MEDIA_PROVIDER_KINDS, AI_PROVIDERS, getProvidersByKind } from "@/shared/constants/providers";
import { translate } from "@/i18n/runtime";
import {
  computeConnectionStats,
  buildProviderCardComparator,
  moveCardInOrder,
  saveProviderCardOrder,
} from "@/shared/utils/providerCardOrder";

// Kinds that support combos (currently disabled for image/tts — temporarily hidden).
// webSearch/webFetch handled by /web page.
const COMBO_KINDS = new Set([]);
const COMBO_BASE_NAMES = { image: "image-combo", tts: "tts-combo" };

// Web studios with no API yet — surfaced on their kind page as open-in-new-tab
// shortcuts. miya.fm sends X-Frame-Options: DENY, so iframe embedding is off the
// table (and its Google-OAuth session would break under a proxying origin anyway).
const EXTERNAL_WEB_TOOLS = {
  music: [
    {
      id: "miya",
      name: "Miya",
      url: "https://miya.fm",
      desc: "Web studio · song + MV · free beta (Gmail login, Discord invite)",
      color: "#0407F4",
      textIcon: "MI",
    },
    {
      id: "flowmusic",
      name: "Flow Music",
      url: "https://www.flowmusic.app",
      desc: "AI music platform for creating, remixing, and sharing songs",
      color: "#000000",
      textIcon: "FM",
    },
  ],
};

function MediaProviderCard({ provider, kind, connections, isCustom, onToggle }) {
  const providerInfo = AI_PROVIDERS[provider.id];
  const isNoAuth = !!providerInfo?.noAuth;

  const { connected, error, total, allDisabled } = computeConnectionStats(connections, provider.id);

  const handleToggleClick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (onToggle) onToggle(provider.id, allDisabled);
  };

  const renderStatus = () => {
    if (isNoAuth) return <Badge variant="success" size="sm">{translate("Ready")}</Badge>;
    if (allDisabled) return <Badge variant="default" size="sm">{translate("Disabled")}</Badge>;
    if (total === 0) return <span className="text-xs text-text-muted">{translate("No connections")}</span>;
    return (
      <>
        {connected > 0 && <Badge variant="success" size="sm" dot>{connected} {translate("Connected")}</Badge>}
        {error > 0 && <Badge variant="error" size="sm" dot>{error} {translate("Error")}</Badge>}
        {connected === 0 && error === 0 && <Badge variant="default" size="sm">{total} {translate("Added")}</Badge>}
      </>
    );
  };

  return (
    <Link href={`/dashboard/media-providers/${kind}/${provider.id}`} className="group">
      <Card
        padding="xs"
        className={`h-full hover:bg-black/[0.01] dark:hover:bg-white/[0.01] transition-colors cursor-pointer ${allDisabled ? "opacity-50" : ""}`}
      >
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div
              className="size-8 rounded-lg flex items-center justify-center shrink-0"
              style={{ backgroundColor: `${provider.color?.length > 7 ? provider.color : (provider.color ?? "#888") + "15"}` }}
            >
              <ProviderIcon
                src={`/providers/${provider.id}.png`}
                alt={provider.name}
                size={30}
                className="object-contain rounded-lg max-w-[30px] max-h-[30px]"
                fallbackText={provider.textIcon || provider.id.slice(0, 2).toUpperCase()}
                fallbackColor={provider.color}
              />
            </div>
            <div className="min-w-0">
              <h3 className="font-semibold text-sm">{provider.name}</h3>
              <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                {isCustom && <Badge variant="default" size="sm">Custom</Badge>}
                {renderStatus()}
              </div>
            </div>
          </div>
          {total > 0 && (
            <div
              className="shrink-0 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100"
              onClick={handleToggleClick}
            >
              <Toggle
                size="sm"
                checked={!allDisabled}
                onChange={() => {}}
                title={allDisabled ? "Enable provider" : "Disable provider"}
              />
            </div>
          )}
        </div>
      </Card>
    </Link>
  );
}

function ComboList({ combos }) {
  if (combos.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {combos.map((combo) => (
        <Link key={combo.id} href={`/dashboard/media-providers/combo/${combo.id}`}>
          <Card padding="xs" className="hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors cursor-pointer">
            <div className="flex min-w-0 items-center gap-3">
              <span className="material-symbols-outlined text-primary text-[18px]">layers</span>
              <code className="text-sm font-mono font-medium flex-1 truncate">{combo.name}</code>
              <div className="flex flex-wrap items-center gap-1 sm:shrink-0">
                {combo.models.slice(0, 6).map((entry, i) => {
                  const pid = typeof entry === "string" ? entry.split("/")[0] : "";
                  const p = AI_PROVIDERS[pid];
                  return (
                    <div key={`${entry}-${i}`} title={p?.name || entry} className="size-5 rounded flex items-center justify-center" style={{ backgroundColor: `${(p?.color ?? "#888")}15` }}>
                      <ProviderIcon
                        src={`/providers/${pid}.png`}
                        alt={p?.name || pid}
                        size={18}
                        className="object-contain rounded max-w-[18px] max-h-[18px]"
                        fallbackText={p?.textIcon || pid.slice(0, 2).toUpperCase()}
                        fallbackColor={p?.color}
                      />
                    </div>
                  );
                })}
                {combo.models.length > 6 && (
                  <span className="text-[10px] text-text-muted ml-1">+{combo.models.length - 6}</span>
                )}
              </div>
              <span className="text-[11px] text-text-muted shrink-0">{combo.models.length}</span>
              <span className="material-symbols-outlined text-text-muted text-[16px]">chevron_right</span>
            </div>
          </Card>
        </Link>
      ))}
    </div>
  );
}

export default function MediaProviderKindPage() {
  const { kind } = useParams();
  const router = useRouter();
  const [connections, setConnections] = useState([]);
  const [customNodes, setCustomNodes] = useState([]);
  const [combos, setCombos] = useState([]);
  const [cardOrder, setCardOrder] = useState([]);
  const [draggingCardId, setDraggingCardId] = useState(null);
  const [dragOverCardId, setDragOverCardId] = useState(null);
  const [showAddCustomEmbedding, setShowAddCustomEmbedding] = useState(false);

  // webSearch/webFetch listing pages are merged into /web
  useEffect(() => {
    if (kind === "webSearch" || kind === "webFetch") {
      router.replace("/dashboard/media-providers/web");
    }
  }, [kind, router]);

  const kindConfig = MEDIA_PROVIDER_KINDS.find((k) => k.id === kind);
  const isEmbedding = kind === "embedding";
  const supportsCombo = COMBO_KINDS.has(kind);

  useEffect(() => {
    if (!kindConfig) return;
    fetch("/api/providers", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setConnections(d.connections || []))
      .catch(() => {});
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d.providerCardOrder)) setCardOrder(d.providerCardOrder);
      })
      .catch(() => {});
    if (isEmbedding) {
      fetch("/api/provider-nodes", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => setCustomNodes((d.nodes || []).filter((n) => n.type === "custom-embedding")))
        .catch(() => {});
    }
    if (supportsCombo) {
      fetch("/api/combos", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => setCombos(d.combos || []))
        .catch(() => {});
    }
  }, [isEmbedding, supportsCombo, kindConfig]);

  if (!kindConfig) return notFound();

  const providers = getProvidersByKind(kind);
  const kindCombos = combos.filter((c) => c.kind === kind);

  // Same ordering as the main providers page: connection state → manual drag
  // order → registry priority → name (shared/utils/providerCardOrder.js).
  const cardComparator = buildProviderCardComparator({
    cardOrder,
    statsOf: (id) => computeConnectionStats(connections, id),
    infoOf: (id) => AI_PROVIDERS[id],
  });
  const sortedProviders = [...providers].sort((a, b) => cardComparator(a.id, b.id));

  const handleCardDrop = (targetId) => {
    const sourceId = draggingCardId;
    setDraggingCardId(null);
    setDragOverCardId(null);
    if (!sourceId || !targetId || sourceId === targetId) return;
    setCardOrder((prev) => {
      const next = moveCardInOrder(prev, providers.map((p) => p.id), sourceId, targetId);
      if (next !== prev) saveProviderCardOrder(next).catch(() => {});
      return next;
    });
  };

  // Map custom nodes to MediaProviderCard shape
  const customProviders = customNodes.map((n) => ({
    id: n.id,
    name: n.name || "Custom Embedding",
    color: "#6366F1",
    textIcon: "CE",
  }));

  const allProviders = [...providers, ...customProviders];

  const handleToggleProvider = async (providerId, newActive) => {
    const providerConns = connections.filter((c) => c.provider === providerId);
    setConnections((prev) =>
      prev.map((c) => (c.provider === providerId ? { ...c, isActive: newActive } : c))
    );
    await Promise.allSettled(
      providerConns.map((c) =>
        fetch(`/api/providers/${c.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isActive: newActive }),
        })
      )
    );
  };

  const handleCreateCombo = async () => {
    const base = COMBO_BASE_NAMES[kind] || `${kind}-combo`;
    let name = base;
    let i = 1;
    const existing = new Set(combos.map((c) => c.name));
    while (existing.has(name)) { name = `${base}-${i++}`; }
    const res = await fetch("/api/combos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, models: [], kind }),
    });
    if (res.ok) {
      const created = await res.json();
      router.push(`/dashboard/media-providers/combo/${created.id}`);
    } else {
      const err = await res.json();
      alert(err.error || "Failed to create combo");
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {(isEmbedding || supportsCombo) && (
        <div className="flex items-center justify-end gap-2">
          {supportsCombo && (
            <Button size="sm" icon="add" onClick={handleCreateCombo}>Create Combo</Button>
          )}
          {isEmbedding && (
            <Button size="sm" icon="add" onClick={() => setShowAddCustomEmbedding(true)}>
              Add Custom Embedding
            </Button>
          )}
        </div>
      )}

      {supportsCombo && kindCombos.length > 0 && (
        <ComboList combos={kindCombos} />
      )}

      {allProviders.length === 0 ? (
        <div className="text-center py-12 border border-dashed border-border rounded-xl text-text-muted text-sm">
          {translate("No providers.")}
        </div>
      ) : (
        <div>
          {/* Section header — same pattern as the /web page: every grouped grid
              gets a titled header (user report: 音乐页第一个分组没有标题）. */}
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <span className="material-symbols-outlined text-primary">{kindConfig.icon}</span>
            <h2 className="text-base font-semibold">{translate(kindConfig.label)}</h2>
            <span className="text-xs text-text-muted">
              ({sortedProviders.length} {translate("providers")}{supportsCombo ? ` · ${kindCombos.length} ${translate("combos")}` : ""})
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {sortedProviders.map((provider) => (
            <DraggableCard
              key={provider.id}
              cardId={provider.id}
              isDragging={draggingCardId === provider.id}
              isOver={dragOverCardId === provider.id && draggingCardId !== provider.id}
              onDragStart={setDraggingCardId}
              onDragOver={setDragOverCardId}
              onDrop={handleCardDrop}
              onDragEnd={() => {
                setDraggingCardId(null);
                setDragOverCardId(null);
              }}
            >
              <MediaProviderCard
                provider={provider}
                kind={kind}
                connections={connections}
                onToggle={handleToggleProvider}
              />
            </DraggableCard>
          ))}
          {customProviders.map((provider) => (
            <MediaProviderCard
              key={provider.id}
              provider={provider}
              kind={kind}
              connections={connections}
              isCustom
              onToggle={handleToggleProvider}
            />
          ))}
          </div>
        </div>
      )}

      {(EXTERNAL_WEB_TOOLS[kind] || []).length > 0 && (
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <span className="material-symbols-outlined text-primary">open_in_new</span>
            <h2 className="text-base font-semibold">{translate("Web Tools")}</h2>
            <span className="text-xs text-text-muted">({EXTERNAL_WEB_TOOLS[kind].length} · {translate("opens in a new tab")})</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {EXTERNAL_WEB_TOOLS[kind].map((tool) => (
              <Card key={tool.id} padding="xs" className="h-full">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <div
                      className="size-8 rounded-lg flex items-center justify-center shrink-0"
                      style={{ backgroundColor: `${tool.color}15` }}
                    >
                      <ProviderIcon
                        src={`/providers/${tool.id}.png`}
                        alt={tool.name}
                        size={30}
                        className="object-contain rounded-lg max-w-[30px] max-h-[30px]"
                        fallbackText={tool.textIcon}
                        fallbackColor={tool.color}
                      />
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-text-main truncate">{tool.name}</div>
                      <div className="text-[11px] text-text-muted truncate">{translate(tool.desc)}</div>
                    </div>
                  </div>
                  <a
                    href={tool.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 shrink-0 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-surface-2 hover:bg-primary hover:text-white text-text-main border border-border transition-colors"
                  >
                    <span className="material-symbols-outlined text-[14px]">open_in_new</span>
                    {translate("Open")}
                  </a>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {isEmbedding && (
        <AddCustomEmbeddingModal
          isOpen={showAddCustomEmbedding}
          onClose={() => setShowAddCustomEmbedding(false)}
          onCreated={(node) => {
            setCustomNodes((prev) => [...prev, node]);
            setShowAddCustomEmbedding(false);
          }}
        />
      )}
    </div>
  );
}
