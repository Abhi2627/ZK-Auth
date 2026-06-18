# Benchmark Setup Guide

Thanks for helping benchmark ZK-Auth! This collects **real performance data**
(real Poseidon hashing, real Groth16 zero-knowledge proof generation, real
HTTP calls to a real backend) on your own machine, so the thesis/papers have
results across multiple devices instead of just one laptop. This should take
**10–15 minutes** of setup + **2–5 minutes** to actually run.

You're only benchmarking on a **laptop or desktop** — no mobile app build
needed for this round.

---

## 1. Prerequisites

You need these installed. If you're an AI/CS student you probably already
have most of these:

| Tool | Check if installed | Install if missing |
|------|---------------------|---------------------|
| **Node.js 20+** | `node --version` | [nodejs.org](https://nodejs.org) (get the LTS version) |
| **Docker Desktop** | `docker --version` and make sure the Docker Desktop app is actually *running* | [docker.com](https://docker.com) |
| **Git** | `git --version` | [git-scm.com](https://git-scm.com) |
| **Python 3.11** | `python3 --version` | [python.org](https://python.org) — only needed for the optional ML service, the benchmark itself works without it |

**Windows users:** use **Git Bash** (installed automatically with Git for
Windows) to run the `.sh` scripts below — plain PowerShell/CMD can't run
them directly.

---

## 2. Clone and install

```bash
git clone https://github.com/Abhi2627/ZK-Auth.git
cd ZK-Auth
npm install
```

`npm install` only needs to run **once, here at the repo root** — it sets up
every workspace (backend, web, benchmark script) in one shot via npm
workspaces. Don't run `npm install` again inside the `benchmark/` folder,
there's nothing to install there.

This step can take a few minutes — it's also compiling/fetching the
`argon2` native module for your specific OS, which is normal.

---

## 3. Set up environment config

```bash
cp backend/.env.local.example backend/.env.local
```

That's it — **no values need to be changed**. The example file is a complete,
working configuration with safe local-dev placeholders (no real secrets),
and rate limits already raised so a 60-trial benchmark run won't get
throttled.

---

## 4. Start everything

```bash
./start.sh
```

This single command starts Docker (Postgres + TimescaleDB + Redis), runs
database migrations, and starts the ML service, backend, and web app —
in that order, with health checks between each step. It'll take a minute
or two the first time.

Wait until you see:

```
╔════════════════════════════════════════════════════════╗
║          ZK-Auth is fully operational! 🚀              ║
╚════════════════════════════════════════════════════════╝
```

**Leave this terminal window open and running** — it streams logs and
keeps all the services alive. Don't close it or press Ctrl+C until you're
done with the benchmark.

> **If something goes wrong here**, see the [Troubleshooting](#troubleshooting)
> section below before asking — it covers the most common issues.

---

## 5. Run the benchmark (in a SECOND terminal)

Open a new terminal window/tab, `cd` back into the repo, then:

```bash
cd ZK-Auth/benchmark
node run_benchmark.mjs --name "yourfirstname"
```

Replace `"yourfirstname"` with your actual first name (or any short
identifier) — this just labels your output file so multiple people's
results don't collide or get mixed up.

This runs 60 full ZKP login cycles (you'll see live progress in the
terminal) plus an Argon2id baseline comparison. It takes roughly **2–5
minutes** depending on your machine.

When it finishes, you'll see something like:

```
  Output file: .../benchmark/results/zkauth-benchmark-yourfirstname-2026-06-18.json

  >>> Send this ONE file back via WhatsApp/email. <<<
```

---

## 6. Send the file back

**That one JSON file is everything I need** — send it to me via WhatsApp or
email, whichever's easier. No screenshots, no copy-pasting terminal output,
just that file. It already contains your machine's specs (CPU, RAM, OS),
all the timing data, and the summary stats — fully self-contained.

---

## 7. Shut down when you're done

Back in the **first terminal** (the one running `./start.sh`), press
`Ctrl+C`. Then, optionally, to also stop the Docker containers:

```bash
./stop.sh
```

---

## Troubleshooting

**`Backend did not start in time` / benchmark can't connect**
Check `.logs/backend.log` in the repo root for the actual error. Common
causes: Docker Desktop isn't running (start the app, not just the CLI),
or a port (3000/3001/5432/5433/6379/50051) is already in use by something
else on your machine.

**`ERROR: auth.wasm not found` / `auth.zkey not found`**
This means the clone didn't pull the compiled circuit files. Try:
```bash
git lfs pull   # only if the repo uses LFS — check with your friend first
```
More likely cause: an incomplete clone. Try re-cloning fresh rather than
debugging a partial one.

**Lots of `challenge_failed_429` errors in the benchmark output**
Rate limiting kicked in. This shouldn't happen with the provided
`.env.local.example` (limits are pre-raised), but if you previously edited
`backend/.env.local` and lowered the limits, you'll need to **restart**
`./start.sh` after changing them — the backend only reads this file once,
at startup, not live.

**Docker containers won't start / "port already allocated"**
Something else on your machine is already using one of Postgres (5432),
TimescaleDB (5433), or Redis (6379)'s ports. Stop whatever that is, or
check `docker compose ps` for stale containers from a previous run and
remove them.

**ML service fails to start**
This is fine to ignore for the benchmark — the backend has a circuit
breaker fallback and the ZKP login benchmark doesn't depend on the ML
service at all. You'll see a yellow warning in the terminal; that's
expected, not an error.

**Something else entirely**
Send me a screenshot of the error plus whichever of `.logs/backend.log`,
`.logs/ml.log`, or `.logs/web.log` looks relevant, and I'll take a look.

---

## What this actually measures (for the curious)

Every number in the output file comes from genuinely running the real
system on your machine — there's no simulation or mocked timing anywhere:

- **Real Poseidon hashing** (the cryptographic hash used inside the ZK
  circuit)
- **Real Groth16 zero-knowledge proof generation** (`snarkjs.groth16.fullProve`,
  against the actual compiled circuit committed in this repo — same one the
  backend verifies against)
- **Real HTTP round trips** to a real Express backend, backed by real
  Postgres and Redis
- **Real Argon2id password hashing** (this project's own production
  parameters) as a comparison baseline against traditional password auth

The output file also includes a few honest methodology notes — for
example, the `/auth/verify` endpoint has a deliberate ~50ms artificial
delay built in as a security measure (preventing timing-based user
enumeration attacks), so that number reflects real verification cost
*plus* that intentional padding, not pure cryptographic cost. The file
explains this so the data isn't misread later.
