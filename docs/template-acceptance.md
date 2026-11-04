# The template acceptance check

**Every example template produces results.** The six templates offered on the New test screen
(`apps/viewer/src/screens/newtest/templates.ts`) are real public websites, and
`scripts/template-acceptance.ts` runs each of them for real — six people, one repeat, on the
model engine — and prints one row per template with the four outcome counts. A template passes
when **at least one** of its sessions ended in an outcome that is not an automation failure.

It exists because the owner's first multi-site runs on `main` (de5f409) produced results on one
site of five: four of the five were six automation failures out of six. Six fixes followed
(#418, #419, #420, #421, #441, #442), and this is the check that they were the right six
(#423).

## What it needs

- **A model key.** `MODEL_API_KEY` in the environment, which lives outside this repository
  (`docs/meta-model-api.md`). The script **refuses to run without it** rather than running
  offline: with no key a model run is recorded and run as offline, and an offline walk of a
  live site proves nothing about the fixes.
- **Chromium**: `pnpm --filter @personavision/browser exec playwright install chromium`.
- **The network**, and five third-party websites up and unchanged enough to be driven.

## What it costs

Six templates × six people × one walk each. A session is a few dozen model calls on the
**contributor** tier — the internal one, the same tier `personavision run` defaults to — so the
whole check is **single-digit dollars** and **a few tens of minutes** of wall clock. The table it
prints carries the measured figures, per template and in total, read off each run's own `usage`
block rather than estimated here.

The sites are driven one at a time: six browsers on one site is already the per-site
concurrency the swarm runs under, and two sites at once would make every wall clock in the table
a measurement of this machine rather than of the site.

## Running it

```sh
pnpm acceptance:templates                          # into ~/.personavision/template-acceptance
pnpm acceptance:templates /tmp/acceptance          # into a runs root of your own
pnpm acceptance:templates /tmp/acceptance ikea-furniture-take-back   # one template again
```

The runs root **defaults to a directory outside the repository**, and the script writes nothing
inside it: `runs/` holds the committed example run, and nothing here regenerates it. The run
directories are **kept** rather than swept — #429 bakes the front page's carousel out of them,
and a swept directory would make it pay for the same live runs a second time.

It exits **0** when every template produced a result and **1** when any one of them did not.
The table is printed either way: a reader who runs this needs the whole table, not an exception.

## Reading the table

| Column                                             | What it is                                                                                            |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `Criterion`                                        | What the template's success criterion is — an `element`, a piece of `text`, or a `url`, read by `criterionToObserve`, the rule the run loop decides a session by |
| `success` / `failed` / `abandoned`                 | The three outcomes a session can be scored as                                                          |
| `automation_failure`                               | The sessions **we** broke. Never a result; the bar is one session that is not one of these              |
| `observed`                                         | How many sessions **observed the criterion**. A success is an observed criterion (#400), and so is the one case that is not a success: a criterion already true when the agent arrived is `failed`, because nothing was tested |
| `Wall clock` / `Cost`                              | Per template, the audience call included, and totalled at the foot                                      |

The `Criterion` column is there because the two kinds are answered by different halves of a
screen: a `url` criterion by the address the screen was captured at, an `element` or a piece of
`text` by what the page drew (#441). A template decided by an address has to be visible as such
in the result.

Under the table: the **first automation failure** of each template that had one, any run that
never started, and a line per template saying whether it produced a **contrast** — a session
that reached the thing and a session that did not, and on which viewports. That last line is
what #429 reads first, because a slide set needs both.

## Where the result goes

**A comment on #423**, as Markdown — which is why the script prints Markdown. Post the table,
the wall clock, the cost and the runs root.

Where a site is still mostly automation failures, post the reason too and open a sibling ticket
for it on step #222. A site that still cannot be driven is a finding, not a silent pass, and the
bar on #423 is never relaxed to make the table green.

## Why it is not in CI

It drives five live third-party sites and spends the owner's model key on every branch, which is
neither polite nor affordable — and a red CI from somebody else's site redesign would be a false
alarm on every pull request (the auto-decision of 2026-11-04 on #423). What CI does cover is
that every template would survive the path a typed test takes:
`apps/viewer/tests/newtest/templates.test.ts` puts each one through the platform's own
`parseSiteUrl`, the contract's own `runRequestSchema` and the run loop's own
`criterionToObserve`. What it cannot cover is whether a live site can be driven, which is this
script.

`tests/template-acceptance.test.ts` covers everything either side of the live runs: what each
template asks for, what the counts are read off, what "observed" means in a session file, which
templates the table calls a pass, and the exit code.
