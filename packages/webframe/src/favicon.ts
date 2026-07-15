const SIZE_PATTERN = /(?:^|[-_./])(?:favicon[-_])?(16|32|48|64|96|128|180|192|256)(?:x\1)?(?:[-_.]|$)/i;
const SMALL_DATA_URL_LIMIT = 32 * 1024;

export function selectFaviconCandidate(input: {
  pageUrl: string;
  candidates: readonly string[];
  previous?: string;
}): string | undefined {
  if (input.candidates.length === 0) return input.previous;
  const pageOrigin = httpOrigin(input.pageUrl);
  const valid = input.candidates
    .map((candidate, index) => faviconScore(candidate, index, pageOrigin))
    .filter((candidate): candidate is FaviconCandidate => candidate !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  return valid[0]?.url ?? input.previous;
}

type FaviconCandidate = { url: string; index: number; score: number };

function faviconScore(candidate: string, index: number, pageOrigin: string | null): FaviconCandidate | null {
  if (!candidate.trim()) return null;
  if (candidate.startsWith('data:')) {
    if (candidate.length > SMALL_DATA_URL_LIMIT) return null;
    return { url: candidate, index, score: 10 };
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const sameOrigin = pageOrigin !== null && url.origin === pageOrigin;
  const size = explicitSize(url.pathname);
  return {
    url: candidate,
    index,
    score: (sameOrigin ? 10_000 : 0) + (size ?? 0),
  };
}

function httpOrigin(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

function explicitSize(pathname: string): number | null {
  const match = SIZE_PATTERN.exec(pathname);
  return match ? Number(match[1]) : null;
}
