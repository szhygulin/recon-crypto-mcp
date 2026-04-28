/**
 * Minimal semver comparator. Just enough for the npm-registry "is there a
 * newer version" check; not a full semver implementation.
 *
 * Recognized shape: `MAJOR.MINOR.PATCH` with optional `-prerelease`
 * (single dotted identifier list) and an optional `+build` suffix that's
 * stripped before compare. Anything malformed → `0` (treat as "not
 * strictly newer") so the update-check gracefully degrades to silence
 * rather than firing a noisy notice on garbage input.
 *
 * Prerelease ordering follows semver §11: any prerelease is LESS than the
 * same MAJOR.MINOR.PATCH without one (so `0.11.0-rc.1` < `0.11.0`).
 * Numeric prerelease identifiers compare numerically; non-numeric
 * compare ASCII.
 */
export type Cmp = -1 | 0 | 1;

interface Parsed {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[] | null;
}

const RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parse(s: string): Parsed | null {
  if (typeof s !== "string") return null;
  const m = RE.exec(s.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split(".") : null,
  };
}

function cmpNum(a: number, b: number): Cmp {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cmpPrerelease(a: string[] | null, b: string[] | null): Cmp {
  if (a === null && b === null) return 0;
  if (a === null) return 1; // no prerelease > any prerelease
  if (b === null) return -1;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i];
    const bi = b[i];
    const an = /^\d+$/.test(ai);
    const bn = /^\d+$/.test(bi);
    if (an && bn) {
      const c = cmpNum(Number(ai), Number(bi));
      if (c !== 0) return c;
    } else if (an !== bn) {
      // Numeric identifiers always have lower precedence than non-numeric.
      return an ? -1 : 1;
    } else {
      if (ai < bi) return -1;
      if (ai > bi) return 1;
    }
  }
  return cmpNum(a.length, b.length);
}

/**
 * Compare two semver strings. Returns -1 if a < b, 1 if a > b, 0 otherwise
 * (including malformed input on either side).
 */
export function compareSemver(a: string, b: string): Cmp {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  let c = cmpNum(pa.major, pb.major);
  if (c !== 0) return c;
  c = cmpNum(pa.minor, pb.minor);
  if (c !== 0) return c;
  c = cmpNum(pa.patch, pb.patch);
  if (c !== 0) return c;
  return cmpPrerelease(pa.prerelease, pb.prerelease);
}

/**
 * True iff `latest` is strictly greater than `current` AND both are stable
 * (no prerelease tag on either side). The "stable beats stable" gate keeps
 * us from nagging users on a stable when the only newer publish is a
 * prerelease — npm's `dist-tag latest` skips prereleases by convention,
 * so this is defense-in-depth rather than expected hot path.
 */
export function isUpdateAvailable(current: string, latest: string): boolean {
  const pa = parse(current);
  const pb = parse(latest);
  if (!pa || !pb) return false;
  if (pa.prerelease !== null || pb.prerelease !== null) return false;
  return compareSemver(latest, current) === 1;
}
