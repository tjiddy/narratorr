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

**If the boot log says the artifact directory is not writable**, check *both* permission bits, not
just the write bit. Creating an entry inside a directory requires the search (execute) bit as well,
so a directory that looks writable can still reject every report and core with `EACCES`:

```bash
docker exec <container> sh -c 'ls -ld /config/crash-reports'   # want drwx------ or better for abc
docker exec <container> chown abc:abc /config/crash-reports
docker exec <container> chmod 700 /config/crash-reports
```

The usual cause is a host bind mount whose directory was created with a mode or owner that does not
grant `abc` both bits.

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

## 7. The libsql statement execution model, and what it rules out (#2595)

The seven SIGSEGVs of 2026-08 were core-confirmed inside
`@libsql/linux-x64-musl@0.5.29/index.node`, always under heavy concurrent DB activity. The obvious
mitigation — serialize statement execution in a JS lane at the client wrapper — assumes concurrent
statement execution exists in this process. **It does not.** That verdict is a measurement, not a
reading of the driver source, and it is pinned by
`src/db/statement-execution-model.integration.test.ts`.

### Method

Three independent observables against a real migrated temp DB, with a recursive-CTE row generator as
the workload (long enough to run far past an event-loop tick, no I/O of its own):

1. **Event-loop occupancy.** A self-rearming `setImmediate` heartbeat, armed and warmed before the
   call, counts ticks during the statement — then repeats over an idle window of the same length so
   the reading has a calibration rather than a bare zero.
2. **Sum vs max.** Two statements issued through `Promise.all`. Genuine overlap costs `max()`;
   serial execution costs the sum.
3. **Synchronous span.** `execute` wrapped to record enter/exit **synchronously around the call,
   without awaiting it** — an `await`-based wrapper reports false overlap for any async facade. The
   span measures how much of the statement happened inside the caller's own frame.

Measured on both `client.execute` and a handle from `client.transaction()`. The transaction handle is
not optional: drizzle dispatches in-transaction queries as `tx.execute` and never `client.execute`
(`drizzle-orm@0.45.2 libsql/session.js`), so a client-only observation point reports zero statements
for everything inside a transaction.

### Numbers (`@libsql/client` 0.17.4 / `libsql` 0.5.29 / `drizzle-orm` 0.45.2)

| Observable | Reading |
|------------|---------|
| 1M-row generator, duration | 247 ms |
| Event-loop ticks during it | **0** |
| Ticks in an idle window of the same length | 143,120 |
| Two statements individually | 245 ms + 243 ms |
| The same two via `Promise.all` | **505 ms** (1.03 × sum; `max()` would be 245 ms) |
| Synchronous enter→exit span of a 249 ms statement | 249 ms |
| Same three readings through a `tx` handle | identical |

### Verdict

**Statement execution in this binding is synchronous and blocks the event loop for its whole
duration.** Two statements are never inside the native binding at the same time, on one connection or
on a transaction handle, and `src/` has no `worker_threads` to create a second caller.

- **Ruled out:** a JS-level serialization lane around `client.execute` / `client.batch` /
  `client.transaction`. It would reorder scheduling and remove **zero** native overlap. `createDb`
  (`src/db/client.ts`) carries a comment saying so, and no lane was added.
- **Not ruled out:** the crash itself. A use-after-free inside the binding does not require two
  simultaneous callers — the fault address in the 08-23 core was a garbage pointer containing ASCII
  bytes. What the measurement removes is one candidate explanation, not the bug.
- **Still in scope, and acted on:** connection lifetime. `BackupService.getAppMigrationCount` used to
  open and `close()` a second connection to the **live** database file while the long-lived one was in
  flight; it now reads through the shared `Db`. That is one removed variable and hygiene, not a
  claimed fix — the default backup interval is weekly, so it cannot explain five crashes in fifteen
  hours. The two remaining separate connections are justified in place: `create()`'s `VACUUM INTO`
  (VACUUM is illegal inside a transaction) and `validateRestore` (a different file — the uploaded
  temp DB).
- **The remaining in-repo lever** is peak statement churn, not statement concurrency. See below.

### Concurrent-wave measurement

A bounded 50-operation wave through real service code — transactional `BookService.create` calls,
bare inserts, and status reads — against a real migrated DB, instrumented on both `client.execute`
and `client.transaction`:

| Quantity | Real client | Async counterfactual |
|----------|-------------|----------------------|
| Total statements | 117 (70 client / 47 in-transaction) | 50 (40 / 10) |
| Transactions opened | 10 | 10 |
| Peak statements in flight (JS layer) | 40 | 50 |
| Binding occupancy | 62 ms | 0.15 ms |
| **Binding occupancy ÷ wall time** | **0.49** | **0.02** |
| Longest uninterruptible block | 3.0 ms | 0.05 ms |
| Wall time | 126 ms | 6 ms |

**Read the ratio, not the peak.** "Peak statements simultaneously inside the binding" sounds like the
number that settles this, but on a single JS thread it is 1 by construction — a counter incremented
and decremented inside one synchronous call frame cannot exceed 1 for a synchronous driver *or* an
asynchronous one, so it is not evidence. The same trap applies to peak-in-flight: 40 and 50 above are
the same shape of overlap, and the JS layer overlaps identically either way.

**Binding occupancy** is what discriminates: the share of the wave's wall time the process spent
blocked inside statement call frames. The real client spends about half the wave unable to turn the
event loop, in ~3 ms blocks, one statement at a time — the other half is drizzle query building and
service JS *between* statements, not binding time. An executor whose work happens off-frame drives
that ratio to ~0.02, and the assertion the real wave passes is false for it. That counterfactual runs
in the same file, through the same probe.

So the application overlaps heavily at the JS layer and none of it reaches the binding — but the
evidence for that is the occupancy ratio, not a peak count.

### If the driver is ever bumped

Re-run `src/db/statement-execution-model.integration.test.ts`. Every assertion in it is written to go
**red** rather than pass quietly if execution becomes genuinely asynchronous, and the file carries a
counterfactual — the same probes against a stub client that really awaits — so the absence readings
are known to be capable of reporting a presence. A red there means this section is stale and the
serialization question is genuinely open again.
