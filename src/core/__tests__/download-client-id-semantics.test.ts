import { describe, it, expect } from 'vitest';
import {
  transmissionSelects,
  sabnzbdSelects,
  delugeResolve,
  delugeStatusResult,
  delugeInvalidTorrentError,
  nzbgetSelects,
} from './download-client-id-semantics.js';

/**
 * #2488 AC8 — the one place each client's ID rule is ASSERTED rather than merely used. Every
 * double for these four clients routes through the module under test, so this fence is what stops
 * a suite quietly re-deriving a rule that inverts the real API's semantics
 * ([[empty-filter-param-is-no-filter]]). Each case carries the citation for the rule it encodes.
 */

const HASH = 'abc123def456';
const OTHER_HASH = '351c0c2d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b';

describe('transmissionSelects — selection axis (rpc-spec.md §3.1)', () => {
  const alpha = { hashString: HASH, id: 7, name: 'Alpha' };
  const beta = { hashString: OTHER_HASH, id: 8, name: 'Beta' };
  const torrents = [alpha, beta];

  // The widening default: an omitted `ids` is what a probing implementation would wrongly adopt.
  it('selects every torrent when ids is absent', () => {
    expect(transmissionSelects(undefined, torrents)).toEqual(torrents);
  });

  it.each<[string, unknown]>([
    ['an empty list', []],
    ['a list holding one empty string', ['']],
    ['a list holding one whitespace string', [' ']],
    ['a list holding an unknown hash', ['ffffffffffffffffffffffffffffffffffffffff']],
    ['a list holding an unknown torrent id', [99]],
  ])('selects nothing for %s', (_label, ids) => {
    expect(transmissionSelects(ids, torrents)).toEqual([]);
  });

  it('selects the named torrent by hash string', () => {
    expect(transmissionSelects([HASH], torrents)).toEqual([alpha]);
  });

  it('selects the named torrent by integer torrent id', () => {
    expect(transmissionSelects([7], torrents)).toEqual([alpha]);
  });

  it('resolves a mixed hash-and-int list per element', () => {
    expect(transmissionSelects([8, HASH], torrents)).toEqual(torrents);
  });

  it('accepts a bare integer as the single-torrent form', () => {
    expect(transmissionSelects(8, torrents)).toEqual([beta]);
  });

  // No case may answer for a torrent the request did not name.
  it('never selects a torrent whose identities the request omitted', () => {
    expect(transmissionSelects([OTHER_HASH], torrents).map((t) => t.hashString)).toEqual([OTHER_HASH]);
    expect(transmissionSelects([`  ${HASH}  `], torrents)).toEqual([]);
    expect(transmissionSelects([HASH.toUpperCase()], torrents)).toEqual([]);
  });
});

describe('sabnzbdSelects — selection axis (sabnzbd/api.py delete handlers)', () => {
  const queued = { nzo_id: 'SABnzbd_nzo_abc123', status: 'Downloading' };
  const done = { nzo_id: 'SABnzbd_nzo_def456', status: 'Completed' };
  const failed = { nzo_id: 'SABnzbd_nzo_ghi789', status: 'Failed' };

  // The widening token is a WORD, not blankness — this is the arm a missing guard would exploit.
  it('widens to every slot on the `all` sentinel, on both axes', () => {
    expect(sabnzbdSelects('queue', 'all', [queued, done])).toEqual([queued, done]);
    expect(sabnzbdSelects('history', 'all', [done, failed])).toEqual([done, failed]);
  });

  it('widens to the failed slots on the history-only `failed` sentinel', () => {
    expect(sabnzbdSelects('history', 'failed', [done, failed])).toEqual([failed]);
  });

  // `failed` is not a queue sentinel, so it is an ordinary (unmatched) nzo_id there.
  it('treats `failed` as a plain nzo_id on the queue axis', () => {
    expect(sabnzbdSelects('queue', 'failed', [queued, done])).toEqual([]);
  });

  it.each<[string, string]>([
    ['an empty value', ''],
    ['a whitespace-only value', '   '],
    ['an unknown nzo_id', 'SABnzbd_nzo_missing'],
  ])('selects nothing for %s', (_label, value) => {
    expect(sabnzbdSelects('queue', value, [queued, done])).toEqual([]);
  });

  it('selects the named job', () => {
    expect(sabnzbdSelects('queue', queued.nzo_id, [queued, done])).toEqual([queued]);
  });

  it('resolves a comma-joined list per element', () => {
    expect(sabnzbdSelects('history', `${done.nzo_id},${failed.nzo_id}`, [done, failed])).toEqual([done, failed]);
  });

  it('never selects a job whose nzo_id the request did not name', () => {
    expect(sabnzbdSelects('queue', ` ${queued.nzo_id} `, [queued, done])).toEqual([]);
    expect(sabnzbdSelects('queue', queued.nzo_id.toUpperCase(), [queued, done])).toEqual([]);
  });
});

describe('delugeResolve — explicit ids (core.py / torrentmanager.py)', () => {
  const status = { hash: HASH, name: 'Test Torrent' };
  const otherStatus = { hash: OTHER_HASH, name: 'Someone Else' };
  const session = { [HASH]: status, [OTHER_HASH]: otherStatus };

  it('resolves the torrent the request named, and reports which id answered', () => {
    expect(delugeResolve(session, HASH)).toEqual({ hash: HASH, status });
  });

  it.each<[string, unknown]>([
    ['an empty string', ''],
    ['a whitespace-only string', '   '],
    ['an unknown hash', 'ffffffffffffffffffffffffffffffffffffffff'],
    ['a padded known hash', `  ${HASH}  `],
    ['a case-differing known hash', HASH.toUpperCase()],
    ['a non-string id', 7],
  ])('misses on %s rather than answering with an arbitrary torrent', (_label, id) => {
    expect(delugeResolve(session, id)).toBeNull();
  });

  /**
   * The property the explicit-id family's doubles exist to hold: the default must not be "the
   * first/only torrent I hold". Deluge's pre-#2488 double returned `mockTorrentStatus` for every
   * `core.get_torrent_status` call whatever id it was handed, so a blank id read as a success.
   */
  it('never answers for an id other than the one asked for', () => {
    for (const id of ['', '   ', HASH, OTHER_HASH, 'unknown']) {
      expect(delugeResolve(session, id)?.hash ?? id).toBe(id);
    }
  });

  // Miss shape #1 — an empty status dict, which `deluge.ts:281-296` maps to `null`.
  it('answers an empty status dict on a get_torrent_status miss', () => {
    expect(delugeStatusResult(session, '')).toEqual({});
    expect(delugeStatusResult(session, HASH)).toBe(status);
  });

  // Miss shape #2 — an InvalidTorrentError, which `rpc()` surfaces as a DownloadClientError.
  it('names the asked-for id in the InvalidTorrentError the control methods raise', () => {
    const error = delugeInvalidTorrentError('   ');

    expect(error.message).toContain('InvalidTorrentError');
    expect(error.code).toBe(4);
  });

  // The two miss shapes must stay distinguishable, or the adapter's two mappings cannot be pinned.
  it('keeps the empty-status miss distinct from the InvalidTorrentError miss', () => {
    expect(delugeStatusResult(session, 'unknown')).not.toHaveProperty('message');
    expect(delugeInvalidTorrentError('unknown')).toHaveProperty('code');
  });
});

describe('nzbgetSelects — explicit ids (NZBGet editqueue)', () => {
  const group = { NZBID: 123, NZBName: 'The Way of Kings' };
  const histItem = { NZBID: 456, Name: 'Words of Radiance' };
  const items = [group, histItem];

  it('selects the item the IDs array named', () => {
    expect(nzbgetSelects([123], items)).toEqual([group]);
  });

  it('resolves a multi-element IDs array per element', () => {
    expect(nzbgetSelects([456, 123], items)).toEqual(items);
  });

  it.each<[string, unknown]>([
    // `JSON.stringify(NaN)` is `null`, which is what `parseInt('') ` used to put on the wire.
    ['an IDs array holding null', [null]],
    ['an IDs array holding a numeric string', ['123']],
    ['an IDs array holding a fraction', [12.5]],
    ['an IDs array holding an unknown NZBID', [999]],
    ['an empty IDs array', []],
    ['a non-array ids argument', 123],
  ])('selects nothing for %s', (_label, ids) => {
    expect(nzbgetSelects(ids, items)).toEqual([]);
  });

  /**
   * The counterfactual for `parseInt('12abc') === 12`: with NZBID 12 absent the coercion is
   * invisible, so the fence pins the property that NZBID 12 must never answer for `'12abc'`.
   */
  it('never selects an NZBID other than the one named', () => {
    const withTwelve = [{ NZBID: 12, NZBName: 'Unrelated' }, ...items];

    expect(nzbgetSelects([12], withTwelve).map((i) => i.NZBID)).toEqual([12]);
    expect(nzbgetSelects(['12abc'], withTwelve)).toEqual([]);
    expect(nzbgetSelects([Number.NaN], withTwelve)).toEqual([]);
  });
});
