# Crash forensics runbook

Narratorr's JavaScript crash instrumentation (`uncaughtException`, `unhandledRejection`, the exit
logger, Node's `--report-on-fatalerror`) cannot see a **native** crash. When the process is killed
by signal 11 (SIGSEGV) from inside a native addon, the only evidence is a **core dump** and the
**host kernel log**. This runbook covers arming those, retrieving them, and handling them safely.

> **Cores are secrets.** A core is a byte-for-byte copy of process memory. It contains the
> decrypted `NARRATORR_SECRET_KEY` and every credential the app had decrypted at crash time.
> **Cores cannot be sanitized.** Never attach one to a public issue and never share one unredacted.
> Diagnostic reports are different — the container passes `--report-exclude-env`, so a report omits
> the environment block. Skim one before sharing it anyway.

## 1. Read the boot log

Every boot logs one crash-forensics line. It has three possible verdicts:

| Verdict | Log line | Meaning |
|---------|----------|---------|
| `armed` | `info` — *Crash forensics armed* | All four legs verified. A segfault will leave a core, and `kill -USR2` will leave a report. |
| `disarmed` | `warn` — *Crash forensics not fully armed: …* | At least one leg is known-bad. The message names each one and what to do. |
| `unknown` | `info` — *Crash forensics readiness could not be fully determined* | One or more legs could not be read (typically a bare-metal or non-Linux host with no `/proc`). Nothing is claimed either way. |

The payload carries the effective values behind the verdict — `coreLimit`, `corePattern`,
`reportDirectory`, `reportFilename`, `artifactDir`, `signal`, `excludeEnv`, plus `disarmedLegs`
and `unknownLegs` — so "is this armed?" is answerable from the boot log without re-deriving
anything.

A bare-metal deployment that never passes the Node report flags logs one disarmed line per boot.
That is the correct answer to "why is there no crash evidence?", not noise.

## 2. Host prerequisite: `kernel.core_pattern`

`kernel.core_pattern` is a **global, non-namespaced sysctl**. A container cannot set it and
narratorr does not try. Set it on the Docker **host**:

```bash
# temporary (until reboot)
sudo sysctl -w kernel.core_pattern='/config/crash-reports/core.%e.%p.%t'

# persistent
echo 'kernel.core_pattern=/config/crash-reports/core.%e.%p.%t' | sudo tee /etc/sysctl.d/60-narratorr-cores.conf
```

For a non-pipe pattern the kernel writes the core through the **crashing process's** mount
namespace, so this absolute path lands inside the container's `/config` volume.

Two notes on that value:

- **The basename is a readability convention only.** Cores are identified by their ELF `ET_CORE`
  content, never by name, so `dump.%p` is found, counted and pruned exactly like `core.%e.%p.%t`.
- **The directory is load-bearing.** A pattern pointing anywhere other than `/config/crash-reports`
  puts the core outside the volume and outside the pruner's reach; readiness reports that as
  disarmed.

If the host uses a **pipe** handler (`|/usr/lib/systemd/systemd-coredump …`, apport, …), the host
handler consumes the core and nothing appears under `/config`. Retrieve it host-side instead:

```bash
coredumpctl list                # find the narratorr node crash
coredumpctl dump <PID> > core   # extract it
```

## 3. The artifact directory is fixed at `/config/crash-reports`

It is **not** derived from `CONFIG_PATH`, and that is structural rather than convenient: a
host-global `kernel.core_pattern` cannot interpolate a per-container environment variable, so the
core destination is necessarily one absolute literal — and the report destination must equal it for
a single pruner to own both.

Consequence: an operator who relocates `CONFIG_PATH` **still** gets crash artifacts under
`/config/crash-reports`, and must still mount `/config` for them to survive.

> **An anonymous volume is not enough.** The image declares `VOLUME /config`, so Docker supplies a
> writable anonymous volume when you provide no explicit bind or named mount. It passes every
> readiness leg and is orphaned the moment the container is recreated. Nothing readable from inside
> the container distinguishes the two, so the readiness check deliberately claims **write access
> only** and never durability. Provide an explicit bind or named mount, and prove it by seeding a
> file, recreating the container, and confirming the file is still there.

## 4. Core-dump limits

The s6 run script sets the **soft** core limit while still root, before dropping privilege, so the
node process inherits it:

- `CRASH_CORE_DUMPS` unset, empty, or anything other than `false` → `ulimit -S -c unlimited`
- `CRASH_CORE_DUMPS=false` → `ulimit -S -c 0`

Both arms act. The container may inherit a nonzero soft limit from its parent, so "leave it alone"
would not be a real opt-out. Both use `-S`: bare `ulimit -c` sets the **hard** limit too, which
would make the opt-out a one-way door that no in-process code could undo.

**If the boot log says the core limit is disarmed** and you did not set `CRASH_CORE_DUMPS=false`,
the inherited **hard** limit is below unlimited and `-S` cannot raise the soft limit past it. Raise
it from the host:

```bash
docker run --ulimit core=-1 …
```

```yaml
# docker-compose.yml
services:
  narratorr:
    ulimits:
      core: -1
```

## 5. Capturing evidence

**Force a verification crash** (dev containers only — this kills the process; s6 restarts it in
about 3 seconds):

```bash
docker exec <container> sh -c 'kill -SEGV $(pidof node)'
ls -l /config/crash-reports/
```

**Capture a live snapshot without killing anything** — the tool for the pre-crash window, e.g.
during a mass search-all-wanted:

```bash
docker exec <container> sh -c 'kill -USR2 $(pidof node)'
# a report.<date>.<time>.<pid>.<seq>.json appears in /config/crash-reports/
```

The report snapshots libuv handles, the heap, and native + JS stacks from the **live** process.

**Read the host kernel log** — the cheapest evidence of all, and it names the faulting shared
object directly:

```bash
journalctl -k | grep -i segfault
# ... node[1234]: segfault at ... in libsql-linux-x64-musl.node[7f...]
dmesg -T | grep -i segfault      # on hosts without journald
```

**Open a core in gdb.** Keep the **exact image tag** that produced the core: the `node` binary and
the native `.node` addons must match the core, or the backtrace is meaningless.

```bash
docker run --rm -it --entrypoint sh -v narratorr_config:/config ghcr.io/…/narratorr:<exact-tag>
apk add gdb
gdb /usr/local/bin/node /config/crash-reports/core.node.412.1755624640
(gdb) bt
(gdb) info sharedlibrary
```

## 6. Retention, and the one file the pruner will not manage

Boot prunes `/config/crash-reports` **before** anything else touches `/config` — before the pending
restore, the migrations, and the database open. A segfault crashloop restarts boot every ~3 seconds,
and cores can be GB-scale on the same volume as the database, so a later prune would never run on
precisely the loop the bound exists to break.

- The newest **2 cores** and the newest **5 reports** are kept, counted **independently** so a burst
  of small reports can never evict the core holding the backtrace.
- Classification is by **content**: ELF `ET_CORE` for cores, a JSON document with a positive-integer
  `header.reportVersion` for reports. Filenames are never consulted, so an artifact written under a
  since-changed `--report-filename` is still bounded.
- **Anything else is left completely alone** — never counted, never deleted. Your `notes.txt`, a
  `core.d/` directory, and the database itself are all safe.

**The over-limit warning.** Reports are parsed with a fixed **8 MiB** cost ceiling. A non-core file
larger than that cannot be classified, so it is **retained but unmanaged**, with one warning naming
it and its size:

```
Crash artifact is too large to classify — it is retained but unmanaged; delete it if it is not needed
    { "file": "huge.json", "size": 900000000 }
```

The remedy is to delete the named file. The limit is deliberately **not** tunable: the alternative —
letting the pruner delete files it cannot identify — would let it evict an operator's unrelated
large file, and deletion is a remedy that is always available and cannot itself be misconfigured.

Cores are exempt from the ceiling entirely: the ELF check settles a core of any size in 18 bytes, so
a 40 GB core is fully covered by the two-core budget.
