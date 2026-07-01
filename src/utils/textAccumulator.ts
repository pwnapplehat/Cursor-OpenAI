/**
 * Accumulates streamed text from a Cursor SDK run.
 *
 * Confirmed by live testing against the real Cursor API (2026-07-01): the
 * `assistant`/`thinking` message events on `Run.stream()` carry incremental
 * text FRAGMENTS, not a growing cumulative snapshot (a snapshot-diffing
 * implementation was tried first and silently dropped everything but the
 * final fragment of multi-fragment replies, e.g. "banana" arrived as three
 * events and came out as "ana"). Each fragment is therefore appended
 * verbatim and returned unchanged as the delta to emit downstream.
 */
export class TextAccumulator {
  private value = "";

  /** Appends `fragment` and returns it unchanged as the delta to emit (empty fragments are ignored and return ""). */
  update(fragment: string): string {
    if (!fragment) return "";
    this.value += fragment;
    return fragment;
  }

  get current(): string {
    return this.value;
  }
}
