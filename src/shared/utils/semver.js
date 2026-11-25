/**
 * SemVer comparison utility supporting prerelease tags (e.g. 1.6.2-test.45).
 * Follows SemVer 2.0.0 precedence rules:
 * - Numeric major, minor, patch comparison.
 * - Same core version: a release (without prerelease) has HIGHER precedence
 *   than any prerelease (e.g. 1.6.2 > 1.6.2-test.45).
 * - Two prereleases: compared identifier by identifier (numeric vs text).
 */

export function parseSemver(v) {
  if (typeof v !== "string" || !v.trim()) return null;
  const clean = v.trim().replace(/^v/i, "");
  const [core, ...preParts] = clean.split("-");
  const nums = core.split(".").map(Number);
  if (nums.some((n) => Number.isNaN(n))) return null;
  while (nums.length < 3) nums.push(0);
  return {
    major: nums[0],
    minor: nums[1],
    patch: nums[2],
    prerelease: preParts.length ? preParts.join("-") : null,
  };
}

/**
 * Compare two semver strings a and b.
 * Returns:
 *   > 0 if a > b (a is newer)
 *   < 0 if a < b (b is newer)
 *   0 if equal
 */
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);

  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;

  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;

  // Same core version (major.minor.patch):
  // According to SemVer, a normal release has higher precedence than a prerelease.
  if (!pa.prerelease && pb.prerelease) return 1;
  if (pa.prerelease && !pb.prerelease) return -1;
  if (!pa.prerelease && !pb.prerelease) return 0;

  // Both have prereleases
  if (pa.prerelease === pb.prerelease) return 0;
  const an = pa.prerelease.split(".");
  const bn = pb.prerelease.split(".");
  const maxLen = Math.max(an.length, bn.length);
  for (let i = 0; i < maxLen; i += 1) {
    const ai = an[i];
    const bi = bn[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    const numA = Number(ai);
    const numB = Number(bi);
    if (!Number.isNaN(numA) && !Number.isNaN(numB)) {
      if (numA !== numB) return numA - numB;
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  return 0;
}

export const compareVersions = compareSemver;

/**
 * Returns true if candidate is strictly newer than current.
 */
export function isNewerVersion(candidate, current) {
  return compareSemver(candidate, current) > 0;
}
