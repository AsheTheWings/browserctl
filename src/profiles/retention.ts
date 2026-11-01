// Which snapshot revisions a profile keeps after a new one: the current one, pinned ones, and the 5 newest.

export const KEEP_NEWEST = 5;

export interface RevisionMark {
  id: string;
  /** Position in creation order; larger is newer. */
  sequence: number;
  pinned: boolean;
}

/** The ids of revisions to delete. */
export function revisionsToDelete(revisions: readonly RevisionMark[], current: string): string[] {
  const newest = new Set(
    [...revisions]
      .sort((a, b) => b.sequence - a.sequence)
      .slice(0, KEEP_NEWEST)
      .map((revision) => revision.id),
  );
  return revisions.filter((revision) => revision.id !== current && !revision.pinned && !newest.has(revision.id)).map((revision) => revision.id);
}
