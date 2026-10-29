/**
 * The name picker's choice, from Teacher's Desk's student randomiser: by
 * default everyone once before anyone twice, because what a class notices
 * about a random picker is the child it picks three times running. Pure, with
 * the random number passed in, so it is tested directly.
 */

export type Person = { id: string; name: string };

export type Pick = {
  person: Person | null;
  /** The turns went round: this pick starts them again (the caller clears who's had one). */
  newRound: boolean;
};

/** `rand` is in [0, 1). */
export function choose(pool: Person[], picked: string[], repeat: "turns" | "any", rand: number): Pick {
  // One entry per person, in case the same student is connected on two devices.
  const seen = new Set<string>();
  const people = pool.filter((p) => p.id && !seen.has(p.id) && seen.add(p.id));
  if (!people.length) return { person: null, newRound: false };
  if (repeat === "any") return { person: people[Math.floor(rand * people.length)], newRound: false };
  const had = new Set(picked);
  const left = people.filter((p) => !had.has(p.id));
  if (!left.length) return { person: people[Math.floor(rand * people.length)], newRound: true };
  return { person: left[Math.floor(rand * left.length)], newRound: false };
}

/** How many in the pool haven't had a turn yet. */
export function turnsLeft(pool: Person[], picked: string[]): number {
  const had = new Set(picked);
  return new Set(pool.filter((p) => !had.has(p.id)).map((p) => p.id)).size;
}
