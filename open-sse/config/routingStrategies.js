// Scheduling-strategy identifiers shared by the combo layer (which member answers)
// and the account layer (which connection of a provider answers).
//
// `round-robin` is NOT one behaviour across the two layers and must never be
// described as if it were:
//   • combo  → idle-window sticky (`comboStickyWindowMinutes`, time based)
//   • account → consecutive-request-count sticky (`stickyRoundRobinLimit`, count based)
// Both keep their own stored value and semantics. This new value is a distinct
// third behaviour, so an existing combo/Provider cannot change shape under a user.
export const ROUND_ROBIN = "round-robin";
export const SESSION_ROUND_ROBIN = "session-round-robin";

// Bounded in-memory state for `session-round-robin`.
export const SESSION_ROUTING = {
  // A session (or its binding) is dropped after this much quiet time, so a
  // abandoned conversation cannot pin a member forever.
  idleMs: 30 * 60_000,
  // Per-caller pool caps: one entry per (caller, combo|provider) scheduling ring.
  maxPools: 512,
  maxBindings: 8192,
  // Ledger of emitted tool-call ids for clients that rotate ids during a tool turn.
  maxAliases: 8192,
  maxToolIds: 64,
  // Never hash/parse oversized values: a caller controls these fields.
  maxIdLength: 256,
  maxMetadataLength: 4096,
  // Stream tap bounds.
  maxFrameBytes: 256 * 1024,
  maxScanNodes: 4000,
};
