# Resuming Aegis on a new machine

> **Purpose.** A one-page cold-start checklist for picking up development on a fresh laptop (or by a fresh
> agent on one). Everything in this repo is pushed to `github.com/25ankurpandey/aegis`; the only things a
> clone does **not** carry are git **push authentication**, local **Docker infra**, and `node_modules` —
> all recreatable below.
>
> **Known-good marker at the time of writing:** branch `feat/agentic-platform`, HEAD `3f75c12`, migrations
> through `0036`, `nx test ai-core` = **201/201** (~870 tests across 9 projects), strict `tsc` clean.
> `main` is untouched; all work lives on `feat/agentic-platform`.

---

## 0. Prerequisites on the new machine
- **Docker** (the only hard prereq for infra + the one-command setup).
- **Node.js** (developed on **v26**; no version is pinned in `.nvmrc`/`engines`, so any recent LTS+ is fine)
  and **npm**.
- **git**, plus a way to authenticate pushes to your **personal** GitHub `25ankurpandey` (see step 3).

## 1. Clone
```bash
# Personal-only machine (simplest — SSH or HTTPS both fine):
git clone git@github.com:25ankurpandey/aegis.git
cd aegis
git checkout feat/agentic-platform      # the active branch; main is untouched
```
Fetch works over HTTPS out of the box. **Push** needs auth — see step 3.

## 2. Install + bring up infra + verify green
```bash
npm ci                                   # install (enables local tests + the log dashboard)

# Bring up local infra on the ports the brain docs standardize on (avoids colliding
# with any existing local Postgres/Redis). docker-compose defaults are 5432/6379.
AEGIS_POSTGRES_PORT=55432 AEGIS_REDIS_PORT=6380 docker compose up -d

# One-command full setup alternative (builds images, starts infra/services/workers,
# runs migrations + seeders). Docker is the only prereq:
#   bash scripts/setup.sh

# Confirm the known-good marker:
npx nx test ai-core                      # expect 201/201
```
> A Docker **restart** stops the containers — re-run the `docker compose up -d` line (with the same port
> env vars) before any **live** DB/Redis test. Live suites (`db`, parts of `ai-core`) need infra up;
> pure-unit suites don't.

## 3. Re-establish git push auth (the ONE thing not in the repo)
On the machine this runbook was written on, the push remote was pinned to a **personal-account SSH alias**
because that laptop had *both* a work and a personal GitHub account (their creds collided):
```
origin  (fetch) https://github.com/25ankurpandey/aegis.git
origin  (push)  git@github-personal:25ankurpandey/aegis.git   # <- alias, machine-specific
```
On the new machine, pick whichever applies:

- **Personal-only machine (most likely):** you don't need the alias. Just make sure a normal personal
  credential works and, if you cloned over HTTPS, point push at SSH or use a PAT:
  ```bash
  git remote set-url origin git@github.com:25ankurpandey/aegis.git
  git push origin feat/agentic-platform            # should succeed once your key/PAT is registered
  ```
- **Machine that ALSO has the work GitHub account:** recreate the collision workaround —
  1. create/copy a personal SSH key (e.g. `~/.ssh/github_personal`) and add its `.pub` to GitHub → the
     `25ankurpandey` account;
  2. add to `~/.ssh/config`:
     ```
     Host github-personal
       HostName github.com
       User git
       IdentityFile ~/.ssh/github_personal
       IdentitiesOnly yes
     ```
  3. pin the push URL: `git remote set-url --push origin git@github-personal:25ankurpandey/aegis.git`
  4. verify: `ssh -i ~/.ssh/github_personal -o IdentitiesOnly=yes -T git@github.com` → should greet
     "Hi 25ankurpandey".

**Commit/push convention:** work on `feat/agentic-platform` (never `main`); after every increment, commit
**and push** so nothing lives only on the laptop.

## 4. Where to read to pick up the work (in order)
1. [`AGENTS.md`](AGENTS.md) — the **▶ RESUME HERE** block (where we are + what to build next).
2. [`docs/brain/STATE.md`](docs/brain/STATE.md) — canonical current state + the ranked Next list.
3. [`docs/brain/PROGRESS.md`](docs/brain/PROGRESS.md) — standing narrative briefing.
4. [`CONTEXT.md`](CONTEXT.md) — full vision/architecture.
5. Append a new session entry to [`docs/brain/AUDIT_LOG.md`](docs/brain/AUDIT_LOG.md) and refresh
   `STATE.md` every pass (the standing doc-sync discipline).

## 5. Not carried by the clone (all recreatable — nothing is lost)
| Item | How to restore |
|---|---|
| `node_modules/` | `npm ci` (step 2) |
| Local Postgres + Redis data | `docker compose up -d` (step 2); `scripts/setup.sh` re-runs migrations + seeders |
| git push auth | step 3 |
| Founder-gated keys (`AEGIS_LLM_*`, embedding key) | never committed; still optional — the shipped slice runs without them |

App `.env` files **are** committed to the repo, so per-service config transfers with the clone.
