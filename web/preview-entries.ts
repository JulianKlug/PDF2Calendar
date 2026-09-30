// Pure helper: picks which row previews the landing lightbox shows for one
// person. Each month is shown once, from its most recent upload; months
// before `now` are dropped.
//
//   entries: sep-oct (Aug 20), oct (Sep 20), nov (Sep 21)   now: Oct
//   → oct (owns Oct), nov (owns Nov); sep-oct owns only past Sep → dropped

type YearMonth = { year: number; month: number };

type PreviewEntry = { uploaded_at: string; months: YearMonth[] };

export function selectPreviewEntries<T extends PreviewEntry>(
  entries: readonly T[],
  now: YearMonth,
): T[] {
  // Month key → most recent entry covering it. ISO timestamps compare as
  // strings.
  const owner = new Map<number, T>();
  for (const entry of entries) {
    for (const m of entry.months) {
      const key = monthIndex(m);
      if (key < monthIndex(now)) continue;

      const current = owner.get(key);
      if (current && current.uploaded_at >= entry.uploaded_at) continue;
      owner.set(key, entry);
    }
  }

  // One slot per entry, ordered by the earliest month it owns.
  const selected: T[] = [];
  for (const key of [...owner.keys()].sort((a, b) => a - b)) {
    const entry = owner.get(key)!;
    if (!selected.includes(entry)) selected.push(entry);
  }
  return selected;
}

// (2026, 10) → 24322: a single sortable number per calendar month.
function monthIndex(m: YearMonth): number {
  return m.year * 12 + (m.month - 1);
}
