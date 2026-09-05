# Contributors page showing upstream contributors — diagnosis & self-healing

> Diagnosed: 2026-09-05 · Status: self-healed (cache rebuild triggered), no history rewrite needed
> Context: v1.0.0 rebrand (fork detach + force-pushed single-line history)

## Symptom

The repository homepage sidebar Contributors block showed **248 contributors**, starting with `@decolua` (the 9router author) and including upstream authors from the 9router chain (`@anuragg-saxenaa`, `@Jordannst`, `@toanalien`, …) plus two AI-bot identities `@claude` and `@cursoragent`. Yet 10Router's main branch is a clean single-line history after the rebrand — it should contain only the maintainer.

## Data-source triage (three endpoints, three answers)

GitHub keeps more than one "contributors" cache — identify the source before drawing conclusions:

| Source | Returns | Nature |
|--------|---------|--------|
| `GET /repos/techysy/10router/contributors` | `techysy` only (273) | **git realtime**: default-branch history; both author emails (`techysy@gmail.com` / `i@shiyangyu.com`) correctly merge into one account |
| `GET /repos/techysy/10router/stats/contributors` | `claude 25` + `techysy 270` | **weekly-stats cache**: residue from pre-detach history |
| Homepage sidebar / `graphs/contributors` | **248 incl. upstream** | **fork-network aggregate cache**: computed while the repo was still inside the 9router fork network |

Key verifications:

```bash
# Repo has left the fork network (fork:false, and absent from 9router's forks list)
gh api repos/techysy/10router --jq '.fork, .network_count'
gh api "repos/decolua/9router/forks?per_page=100" --jq '.[].full_name' | grep 10router   # no result

# No remote branch carries upstream commits (rules out a stale branch with old history)
git ls-remote --heads origin
for b in main zcode fix/issue-4-stream-default; do
  git rev-list --count --author=decolua "origin/$b"   # all = 0
done
```

## Root cause

10Router started life as a **fork of 9router**. The v1.0.0 rebrand did two things: force-pushed a clean single-line history (root commit `fd7a881c`, no parent; its message "Merge remote-tracking branch 'upstream/master'…" is a misleading artifact of the rewrite, not a real merge), then **detached from the fork network**.

But GitHub's Contributors sidebar/graphs aggregate contributors across the **entire fork network**, and that cache **does not invalidate immediately on detach** — the 248-person list is the pre-detach result. The `claude 25` in `stats/contributors` is the same phenomenon: the local reflog still shows `Claude Code <nadimtuhin@gmail.com>` from the discarded old history (an upstream-era contributor's Claude Code session commits).

`@claude` and `@cursoragent` are **real bot committers in upstream 9router history** — their presence in an upstream aggregate view is normal, not a data error.

## Resolution: let the cache rebuild, do not touch history

- **Visiting the graphs page triggers a rebuild** (the page shows "Crunching the latest data…"); once rebuilt, the data source switches back to the repo's own default-branch history — the 248 people, upstream authors, and bot ghosts all disappear, leaving only `@techysy`. That is exactly how this case self-healed.
- **Push events also trigger recomputation**: merging a PR or any routine commit refreshes the cache.
- If it stays stale for a long time (>2 weeks): `git commit --allow-empty -m "chore: refresh contributors cache" && git push` to force another rebuild.
- **Do not** rewrite history over a contributors display issue (force-pushing only creates new cache inconsistencies); **do not** contact GitHub Support to fix contributors data — they don't offer that service; the cache rebuilds on its own schedule.

## Conclusion & prevention

- The repository history itself is clean: all 271 non-merge commits belong to the maintainer; patch-id duplicate detection found only 3 pairs (normal rework when merging the qoder-cn branch).
- Contributors-view lag after a fork detach is **expected behavior**. When you see names from the old network, triage the three data sources first — don't rush to rewrite history.
- The verification command template above is reusable for attribution checks after any fork rebrand.
