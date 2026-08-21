/**
 * One home for how the four non-qBittorrent download clients resolve the IDs a request names
 * (#2488). Every test double for these clients routes its id decision through this module, and
 * `download-client-id-semantics.test.ts` is the one place the rules are ASSERTED rather than used.
 *
 * The four APIs fall into two families, and the difference decides what each model's *default*
 * must be — the answer a missing guard would exploit, so a regression reds instead of passing
 * vacuously ([[shared-test-double-defaults]], [[vacuous-assertion-observation-points]]):
 *
 * - **Selection-axis** (Transmission, SABnzbd): the request carries a selector that can be
 *   ineffective, and the API decides what an ineffective one selects. The dangerous answer is
 *   WIDENING, so the model must be able to produce it.
 * - **Explicit-id** (Deluge, NZBGet): every call names the ids it acts on and there is no
 *   empty-means-all case. The dangerous answer is MIS-RESOLUTION, so the model resolves by exact
 *   match only and never answers for an id it was not given. No widening default is imposed on
 *   either — neither API has one, and asserting one would model behavior that does not exist.
 *
 * The qBittorrent instance of this lives in `qb-hash-filter.ts` (#2485) and stays there.
 */

/** Anything a Transmission `ids` element can name: the int torrent id or the SHA-1 hash string. */
export interface TransmissionIdentifiable {
  hashString: string;
  id?: number;
}

/**
 * Transmission `torrent-get` / `torrent-stop` / `torrent-start` / `torrent-remove` `ids` argument
 * (Transmission 4.0.x `docs/rpc-spec.md` §3.1 "Torrent Action Requests"): an OMITTED `ids` means
 * ALL torrents, while a present `ids` is a per-element lookup over torrent-id ints and hash
 * strings, and an element no torrent answers to selects nothing.
 *
 * So `ids: ['']` is a present-but-unmatched filter, not the widening one — but the widening arm is
 * one dropped key away, which is why the guard refuses ahead of request construction rather than
 * relying on this answer holding across builds.
 */
export function transmissionSelects<T extends TransmissionIdentifiable>(
  ids: unknown,
  torrents: readonly T[],
): T[] {
  if (ids === undefined) return [...torrents];
  const elements = Array.isArray(ids) ? ids : [ids];
  return torrents.filter((torrent) =>
    elements.some((element) =>
      typeof element === 'number' ? element === torrent.id : element === torrent.hashString,
    ),
  );
}

/** The `nzo_id`-bearing shape both SABnzbd axes share. */
export interface SabnzbdIdentifiable {
  nzo_id: string;
  status?: string;
}

/**
 * SABnzbd `mode=queue&name=delete&value=` and `mode=history&name=delete&value=`
 * (`sabnzbd/api.py`, `_api_queue_delete` / `_api_history`): the widening token is the literal word
 * `all` on both axes, plus `failed` on history — NOT blankness. Anything else is split on `,` and
 * matched against `nzo_id` exactly, so a blank `value` matches the sentinel branch on neither side
 * and selects nothing.
 *
 * `addDownload` returns a real `nzo_id`, so neither sentinel is producible through this app's own
 * write path; they are documented here, not defended against (#2488 Out of Scope).
 */
export function sabnzbdSelects<T extends SabnzbdIdentifiable>(
  axis: 'queue' | 'history',
  value: string | null,
  slots: readonly T[],
): T[] {
  if (value === null) return [];
  if (value === 'all') return [...slots];
  if (axis === 'history' && value === 'failed') {
    return slots.filter((slot) => slot.status === 'Failed');
  }
  const named = value.split(',');
  return slots.filter((slot) => named.includes(slot.nzo_id));
}

/**
 * Deluge `core.get_torrent_status` / `core.pause_torrent` / `core.resume_torrent` /
 * `core.remove_torrent` (deluge `core/core.py` + `core/torrentmanager.py`): every call names its
 * torrent ids explicitly and matching is exact string equality against the session's keys —
 * nothing is case-folded, trimmed, or prefix-matched. There is no selection axis to widen.
 *
 * Carrying the resolved hash back is what makes "never answers for an id it was not given"
 * assertable at the call site rather than only in the fence.
 */
export function delugeResolve<T>(
  torrents: Readonly<Record<string, T>>,
  id: unknown,
): { hash: string; status: T } | null {
  if (typeof id !== 'string') return null;
  if (!Object.prototype.hasOwnProperty.call(torrents, id)) return null;
  return { hash: id, status: torrents[id]! };
}

/**
 * Deluge miss shape #1 — `Core.get_torrent_status` answers an EMPTY status dict for an id the
 * session does not hold, which `deluge.ts:281-296` maps to `null`.
 */
export function delugeStatusResult<T extends object>(
  torrents: Readonly<Record<string, T>>,
  id: unknown,
): T | Record<string, never> {
  return delugeResolve(torrents, id)?.status ?? {};
}

/**
 * Deluge miss shape #2 — the control methods index `TorrentManager.__getitem__`, which raises
 * `InvalidTorrentError`; the JSON-RPC envelope carries it as an `error` and `deluge.ts`'s `rpc()`
 * surfaces it as a `DownloadClientError`. Error code 4 is Deluge's generic RPC-error code.
 */
export function delugeInvalidTorrentError(id: unknown): { message: string; code: number } {
  return { message: `InvalidTorrentError: torrent_id ${String(id)} not in session`, code: 4 };
}

/** The `NZBID`-bearing shape shared by `listgroups` entries and `history` items. */
export interface NzbgetIdentifiable {
  NZBID: number;
}

/**
 * NZBGet `editqueue(Command, Param, IDs)` (NZBGet JSON-RPC API, `editqueue` method): the third
 * argument is an explicit array of NZBIDs — there is no empty-means-all axis. An element that is
 * not an integer NZBID (a `null` from `JSON.stringify(NaN)`, a string, a fraction) names no
 * download, and an unknown integer names none either.
 *
 * `parseInt` in front of this used to make `'12abc'` a valid-looking NZBID 12
 * ([[parsefloat-grouped-number-truncation]]), which is why the model refuses to answer for any id
 * other than the one it was handed.
 */
export function nzbgetSelects<T extends NzbgetIdentifiable>(
  ids: unknown,
  items: readonly T[],
): T[] {
  if (!Array.isArray(ids)) return [];
  return items.filter((item) =>
    ids.some((element) => typeof element === 'number' && Number.isInteger(element) && element === item.NZBID),
  );
}
