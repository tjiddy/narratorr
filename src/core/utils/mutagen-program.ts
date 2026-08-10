/**
 * The tag writer runs as `<python> -c MUTAGEN_PROGRAM`, one process per file, with the request on
 * stdin and the result on stdout — both UTF-8 JSON. argv is visible in `ps` and a description is
 * unbounded, so no tag value may travel as an argument (#2210 D1/AC16).
 *
 * Shipping this as a `docker/*.py` asset was rejected: `tsup.config.ts` bundles the server entry and
 * copies no non-TS files, so the script's on-disk location would differ between `pnpm dev` and the
 * image. A string constant has no resolver.
 *
 * Request:  { path, format: 'mp4'|'id3', ops: [{ key, kind, value }], cover: { path, mime } | null }
 * Response: { ok, sizeBefore, sizeAfter, verified: { <key>: <read-back string> }, coverDigest?, error? }
 *
 * `verified` is re-read from a freshly reopened file *after* save, in this same process — that
 * read-back is the integrity predicate, replacing the old output-size heuristic entirely (D2).
 *
 * A requested cover reports the SHA-256 of the reopened image under `__cover__` and its stored mime
 * under `__cover_format__`, while `coverDigest` carries the SHA-256 of the source file the helper
 * read. Only this process sees both sides, so it reports both and lets the caller adjudicate.
 * Comparing digests is what proves the OLD art was actually replaced: a byte-length check cannot,
 * because a retained cover is also nonzero.
 *
 * NOTE: keep this program free of backslashes — TypeScript processes escape sequences inside a
 * template literal, so a Python `\n` or `\x` would be mangled before Python ever sees it.
 */
export const MUTAGEN_COVER_VERIFY_KEY = '__cover__';
export const MUTAGEN_COVER_FORMAT_KEY = '__cover_format__';

export const MUTAGEN_PROGRAM = `
import hashlib, json, os, sys

def load_request():
    return json.loads(sys.stdin.buffer.read().decode('utf-8'))

def read_cover_bytes(cover):
    with open(cover['path'], 'rb') as handle:
        return handle.read()

def run_mp4(request):
    from mutagen.mp4 import MP4, MP4Cover, MP4FreeForm, AtomDataType
    formats = {'image/jpeg': MP4Cover.FORMAT_JPEG, 'image/png': MP4Cover.FORMAT_PNG}
    mimes = {int(MP4Cover.FORMAT_JPEG): 'image/jpeg', int(MP4Cover.FORMAT_PNG): 'image/png'}
    path = request['path']
    ops = request['ops']
    cover = request.get('cover')
    cover_digest = None

    audio = MP4(path)
    for op in ops:
        key, kind, value = op['key'], op['kind'], op['value']
        if kind == 'text':
            audio[key] = [value]
        elif kind == 'freeform':
            audio[key] = [MP4FreeForm(value.encode('utf-8'), AtomDataType.UTF8)]
        elif kind == 'int':
            audio[key] = [int(value)]
        elif kind == 'pair':
            first, second = value.split('/')
            audio[key] = [(int(first), int(second))]
        else:
            raise ValueError('unsupported op kind: ' + kind)
    if cover:
        image_format = formats.get(cover['mime'])
        if image_format is None:
            raise ValueError('unsupported cover mime: ' + cover['mime'])
        cover_bytes = read_cover_bytes(cover)
        cover_digest = hashlib.sha256(cover_bytes).hexdigest()
        audio['covr'] = [MP4Cover(cover_bytes, imageformat=image_format)]
    audio.save()

    reopened = MP4(path)
    verified = {}
    for op in ops:
        key, kind = op['key'], op['kind']
        values = reopened.get(key)
        if not values:
            continue
        value = values[0]
        if kind == 'freeform':
            verified[key] = bytes(value).decode('utf-8')
        elif kind == 'pair':
            verified[key] = str(value[0]) + '/' + str(value[1])
        else:
            verified[key] = str(value)
    if cover:
        stored = reopened.get('covr')
        if stored:
            verified['__cover__'] = hashlib.sha256(bytes(stored[0])).hexdigest()
            verified['__cover_format__'] = mimes.get(int(stored[0].imageformat), 'unknown')
    return verified, cover_digest

def run_id3(request):
    import mutagen.id3 as id3
    from mutagen.id3 import ID3, ID3NoHeaderError
    path = request['path']
    ops = request['ops']
    cover = request.get('cover')
    cover_digest = None

    try:
        tag = ID3(path)
    except ID3NoHeaderError:
        tag = ID3()
    for op in ops:
        key, kind, value = op['key'], op['kind'], op['value']
        if kind == 'text':
            tag.add(getattr(id3, key)(encoding=3, text=[value]))
        elif kind == 'freeform':
            frame_id, description = key.split(':', 1)
            if frame_id != 'TXXX':
                raise ValueError('unsupported freeform frame: ' + key)
            tag.add(id3.TXXX(encoding=3, desc=description, text=[value]))
        else:
            raise ValueError('unsupported op kind: ' + kind)
    if cover:
        if cover['mime'] not in ('image/jpeg', 'image/png'):
            raise ValueError('unsupported cover mime: ' + cover['mime'])
        cover_bytes = read_cover_bytes(cover)
        cover_digest = hashlib.sha256(cover_bytes).hexdigest()
        # APIC hashes on its description, so replacing art means clearing the frame class first.
        tag.delall('APIC')
        tag.add(id3.APIC(encoding=3, mime=cover['mime'], type=3, desc='Cover',
                         data=cover_bytes))
    tag.save(path)

    reopened = ID3(path)
    verified = {}
    for op in ops:
        key = op['key']
        frame = reopened.get(key)
        if frame is None or not frame.text:
            continue
        verified[key] = str(frame.text[0])
    if cover:
        pictures = reopened.getall('APIC')
        if pictures:
            verified['__cover__'] = hashlib.sha256(pictures[0].data).hexdigest()
            verified['__cover_format__'] = pictures[0].mime
    return verified, cover_digest

try:
    request = load_request()
    size_before = os.path.getsize(request['path'])
    if request['format'] == 'mp4':
        verified, cover_digest = run_mp4(request)
    elif request['format'] == 'id3':
        verified, cover_digest = run_id3(request)
    else:
        raise ValueError('unsupported format: ' + str(request['format']))
    result = {'ok': True, 'sizeBefore': size_before,
              'sizeAfter': os.path.getsize(request['path']), 'verified': verified}
    if cover_digest is not None:
        result['coverDigest'] = cover_digest
except Exception as error:
    result = {'ok': False, 'error': type(error).__name__ + ': ' + str(error)}

sys.stdout.write(json.dumps(result))
`;
