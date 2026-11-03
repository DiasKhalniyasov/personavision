# `@personavision/personas`

The audience, and the people generated from it.

An audience is the product's first-class object: the user describes the customers their
business actually serves, and PersonaVision generates the simulated people a test runs with
from that description (`docs/FLOW.md` section 1). Nobody picks four stock personas.

```ts
import { generatePersonas, OUTDOOR_GEAR_SHOPPERS } from '@personavision/personas';

const people = generatePersonas(OUTDOOR_GEAR_SHOPPERS); // the audience's own seed
const group = generatePersonas(OUTDOOR_GEAR_SHOPPERS, { seed: 2 }); // one seed group of a run
```

`generatePersonas` returns `audience.size` people. Same audience and same seed, byte-identical
people; the swarm step (#49) runs the same people against every variant, so a comparison is
never confounded by who was tested.

**The audience's shape is not declared here.** It is `@personavision/contract`'s
`audienceSchema`, because a run artifact carries a copy of the audience it was tested for,
and no package but the contract declares an artifact field name. What lives here is the
behaviour: which audience field moves which trait, how the spread around the audience is
drawn, and how the device mix is honoured. Generated people are parsed by the contract's own
`personaSchema` on the way out, so a field this package mis-spelled cannot reach a caller.

Nothing is precomputed for the engine. A person leaves here as the six traits on the 0..1
scale, and the engine's own table (`packages/engine/src/persona.ts`, #56) is the single place
they become sampling parameters. The decision layer reads the traits directly.

## The audience decides who exists; the seed decides who they are

The audience sets a **centre** on each trait and the number of people. Round the centre, each
person is placed at a named **archetype** — a corner of the audience's behaviour — and the
seed jitters them away from it. So:

- the same audience always reports the same device mix and the same segments, and two tests
  of one audience under different seeds compare like with like;
- the same audience and seed are the same people, to the last digit;
- a different seed is different people, because every trait is re-sampled.

## 1. The audience's centre

`traitCentre(audience)`. Every coefficient is a named constant in `src/audience.ts`.

| Trait                  | Centre                                    | Why                                                                                                                                                            |
| ---------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `interfaceFamiliarity` | `0.5 + 0.80·(tech − 0.5)`                 | The contract says `techSavviness` moves it **directly**: it is the trait that field is about, so it takes the largest coefficient and nothing else touches it. |
| `scanningVsReading`    | `0.5 + 0.40·(tech − 0.5) − 0.20·ageSkew`  | Tech-confident eyes scan; a younger audience scans. Both directions are the contract's.                                                                        |
| `detailOrientation`    | `0.5 + 0.50·(price − 0.5)`                | Price sensitivity is read closely: a total and a fee get looked at.                                                                                            |
| `patience`             | `0.5 − 0.30·(price − 0.5) + 0.25·ageSkew` | Price sensitivity costs patience once a price moves; an older audience gives up later.                                                                         |
| `persistence`          | `0.5`                                     | No audience field is connected to it, so none moves it.                                                                                                        |
| `riskTolerance`        | `0.5`                                     | The same.                                                                                                                                                      |

`ageSkew` is `(ageMidpoint − 40) / 25`, clamped to ±1: 40 is the middle of the adult
web-using range and 15 and 65 are the ends of it. Beyond them the age terms stop moving rather
than running off the scale.

Three choices worth stating:

**Every coefficient is short of the full range, `interfaceFamiliarity` included.** A centre on
0 or 1 has room on one side only: everybody an archetype pushes the other way arrives at the
boundary together, and an audience of one strong opinion reports clones on that trait — the one
failure that would pass a naive bounds test and leave the product with nothing to report. The
contract's "directly" is about which trait `techSavviness` moves, not about the arithmetic, so
familiarity takes the largest coefficient of the five rather than the identity.

**`goals` and `roles` move no trait.** `goals` are carried through to the engine's top-down
goal relevance, which the contract is explicit about. `roles` name no generated person either:
the four people the design contract names are _behaviours_ — Rushed buyer, Careful comparer —
and the demo audience's roles are _First-time buyer_ and _Returning customer_, so a role
cannot be the source of those names. The Audience screen's hint says roles name the generated
people; what is built names them for behaviour instead, which is what the prototype, the
committed example run and every fixture already show. Recorded as a decision for the owner.

**`persistence` and `riskTolerance` sit at the midpoint.** Deriving them from a field the
contract does not connect them to would be this package inventing a claim about people, and
every number the product reports rests on these six. They still vary across a generated set,
from the archetype and the seed.

## 2. The archetypes: four corners, not four people

`src/archetypes.ts`. The four are the design contract's, not this file's invention:
`docs/design/prototype.html`'s `PERSONAS` constant names them and its Audience screen draws
each with the behaviour it stands for. The offsets are those descriptions written as numbers,
added to the centre and clamped to 0..1, and the table's order is the prototype's.

| Archetype                       | Segment clause       | Device   | Reads as                          |
| ------------------------------- | -------------------- | -------- | --------------------------------- |
| `rushed` Rushed buyer           | `in a hurry`         | touch    | scanning, impatient, takes risks  |
| `careful` Careful comparer      | `compares carefully` | no touch | reading, detail-oriented, patient |
| `firsttime` First-time visitor  | `first visit`        | no touch | low familiarity, slightly patient |
| `price` Price-sensitive scanner | `price-sensitive`    | touch    | scanning, price-led, impatient    |

People are allocated round-robin over the table, so a swarm covers the whole spread at every
size rather than leaving a corner out: 4 people are one of each, 24 are six of each. The first
person at a corner takes the archetype's bare id and name — `rushed`, _Rushed buyer_ — and
later ones are numbered, `rushed-2`, _Rushed buyer 2_, because a row on the Sessions screen
has to name people apart.

Two properties hold the table honest, asserted in `tests/archetypes.test.ts`:

1. **Every column sums to zero.** The corners displace people around the centre without moving
   it, so the median of a generated set tracks the audience and "raising `priceSensitivity`
   raises `detailOrientation`" is true at every size, rather than depending on how many people
   happened to be generated.
2. **No offset is as large as 0.5.** An offset is a direction and a distance, never an absolute
   value, so an audience at the end of a scale keeps its spread in the direction it has room in.

The seeded jitter is ±0.1, uniform, six draws per person in the contract's trait order. It is
small on purpose: the corner is the claim about behaviour and the jitter is individual
variation around it, not a second source of spread.

**A displacement is a fraction of the room left, not a sum.** Offset plus jitter is measured
against the furthest corner the table holds — `MAX_OFFSET`, read off the table so that editing
an offset moves the geometry with it — and that fraction is applied to the distance from the
centre to whichever end of the scale it points at. Where there is room on both sides it works
out as the plain sum, so the ordinary case is the obvious arithmetic; near an end it bends
instead of flattening. The clamp is still the last word and, by construction, has nothing left
to do: `tests/generate.test.ts` asserts that none of the extreme audiences generates two
identical people, and that nobody shares a boundary value with anybody else.

### What this reproduces

Generated from the committed preset at seed `20261024`, the four people land within **0.1 of
the traits a human hand-wrote for them** in the committed example run on 19 of 24 values, mean
0.07, worst 0.24 — without the generator having seen them. The ids, names, segments and devices
match exactly, and `tests/preset.test.ts` pins all four.

What it does **not** reproduce is those traits themselves, and the committed artifact overstates
its own provenance because of it: `run.json` names `generatorVersion: "persona-gen-1"` beside
four people whose traits were transcribed from the prototype by hand, not generated. The pin
here is deliberately on who the four people are — id, name, segment, device — and
`tests/preset.test.ts` says so. Closing the gap means regenerating the artifact's personas and
the traits each session file embeds with them, which is #78's work, not this package's.

## 3. The device mix

`src/devices.ts`. An audience's `devices[]` is a mix of device **classes** with a nominal
viewport and a share — `mobile` 390 × 844 at 60%, `desktop` 1280 × 800 at 40% — which is what
the Audience screen draws as chips. A generated person carries the **concrete** device it ran
on, `iPhone 15` or `MacBook Air 13` at 1440 × 900, which is what a session records and what
gaze is projected from. The two may differ on the viewport; that reading is the project's
(decision 3, on #105 and #106), and the rule it leaves here is _honour the shares, not the
viewports_.

**How many** people are on each device is largest-remainder apportionment of `size` over the
shares: a declared 60% is 60% of the people, to within one person, at every size and for every
seed — except where the representation floor below raises a device with less than one person's
worth of share, which is the one thing allowed to overrule a share. Drawing each person's device independently would leave the mix a test reports some way
from the mix the user authored, and at the demo's size of four it could leave a declared device
with nobody on it at all.

**Every declared device gets somebody**, once the audience has at least as many people as
devices: a device declared at 1% is part of the audience, and a swarm that puts nobody on it
reports nothing about it. The person comes from the largest count. Below that size the people
go to the largest shares — nobody is left out while a smaller share is covered, and a share
worth more than one of the few people still takes more than one of them — because there is no
honest way to cover more devices than people. `tests/apportionment.test.ts` holds all of this
over random share vectors at every size a swarm plausibly runs at.

**Who** gets which device is the archetype's affinity: a hurried shopper is a phone behaviour
and a careful comparer sits at a desk, so the phone-shaped behaviours fill the phone share
first and a desk-shaped one spills onto it only when the desk share is used up. The counts are
the shares either way; this decides the pairing, and it is the pairing the prototype draws.

A class the concrete table does not know keeps its own name and geometry, so an audience may
declare any device without this package being edited. A known class whose declared `touch`
disagrees with the model's keeps its own too: a touch device implies the mobile viewport and
the fold that goes with it, and a lookup table does not get to overrule the audience on that.

## 4. The three fields the audience draws

`docs/FLOW.md` section 12 extends the audience with a **gender split**, **age groups** and a
**language** list, and leaves the generator's mapping table three new rows (#278). The table
itself is in `src/audience.ts`, beside the arithmetic it describes:

| Audience field | What it moves                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `genderSplit`  | the `gender` each person is drawn as, by share                                                                            |
| `ageGroups`    | the bracket each person is drawn from and the age they are drawn at — and so their own `patience` and `scanningVsReading` |
| `languages`    | the one `language` each person reads and types in, **apportioned evenly**                                                 |

**One rule for every share.** The largest-remainder apportionment the device mix is built on
is `largestRemainder` in `src/devices.ts`, and all three of these go through it, so a declared
share is the same promise whichever field declared it: a hundred people with a 54/46 split are
54 and 46, not 54 and 45, at every size and for every seed. The counts sum to `size` exactly —
nobody left over, nobody counted twice — including when the shares only nearly sum to one,
which the contract's tolerance allows.

**The representation floor is the device mix's alone.** A device is declared by being in the
list, whatever its share, and a test that puts nobody on it reports nothing about that device;
so the floor gives every declared device somebody. A share of **zero** on a gender or an age
bracket is the opposite kind of statement — it is the audience saying nobody here is that —
and flooring it would put a person somewhere the audience said nobody was. For an age bracket
it would be worse than wrong: the contract holds `ageRange` consistent only with the brackets
that carry somebody, so a person floored into an empty bracket could be an age the audience's
own range excludes. Languages need no floor; apportioned evenly, every language in the list
gets somebody as soon as there are as many people as languages.

**Even, for languages, because nobody gave shares.** A language list is a list. Reading shares
into it would be this package inventing a claim about the audience, so the same rule runs over
an equal share each — three languages over a hundred people are 34, 33 and 33 — and the list's
own order breaks the tie. The gender split's two words are read off the split itself rather
than written out here, sorted so that an audience written `{ female, male }` and the same
audience written `{ male, female }` draw one set of people; sorted, `female` leads, so a 50/50
split over an odd number of people gives the odd person to `female`. Arbitrary, and the same
arbitrary answer every time, which is the property that matters.

**The audience decides how many; the seed decides who.** The apportionment is the audience's
and is the same at every seed, exactly as the device mix is, so two seed groups of one run
report one gender split and one language mix and compare like with like. Which _person_ gets
which value is the seed's, and it is **shuffled** rather than dealt in order: people are placed
at the four archetypes round-robin, so handing a two-value field out in order — or alternately
— would make the field a proxy for the behaviour beside it, and every result grouped by
language would be reporting the archetype instead. Each field is dealt on a stream of its own,
salted off the set's seed, so adding a language list to an audience does not move the genders
of the people it already generated.

**An age group moves a trait; it is not a field of the person's.** The bracket is the
audience's claim and the year inside it is this person's, drawn uniformly over the bracket
**narrowed to `ageRange`**: an audience of 28 to 44 that declares 25–34 and 35–44 said nobody
here is 27, so a person drawn from 25–34 is 28 to 34. `65+` takes `ageRange.max` as its top,
because that is the only upper bound anybody stated. What the age then does is what the
mapping table has always said age does — `patience` up with age, `scanningVsReading` up as the
person is younger — applied to the age **this person** was drawn at rather than to the midpoint
of the whole range. Same two coefficients, same two directions, one centre per person. So an
audience that is mostly in its thirties with a tail at fifty generates people whose patience is
their own age's rather than the tail's.

The age is not stored on the persona. Decision 104 put what a person was _drawn as_ in two
fields of the persona's own — `gender` and `language` — and explicitly rejected the optional
`profile` block as the home for it, because `profile` is prose nobody wrote and an age nobody
drew. Writing a `profile` for all hundred generated people in order to carry the year would be
that rejected option, and it would put an invented _"who you are"_ sentence into the agent's
model prompt, which reads `profile.about`. So the year lives where the two coefficients put it:
in the traits the person carries. What a bracket means in years is read off its own label —
`25–34` is 25 to 34 wherever it is printed — so a bracket added to the contract needs no edit
here and there is no second table of years to drift from the first.

### Why this is not a new generator version

`GENERATOR_VERSION` is still `persona-gen-1`, and adding these three rows did not move it.

All three fire **only on an audience that carries the field**. An audience declaring none of
them draws byte-identical people — same ids, same names, same segments, same devices, same
traits to the last digit — because the three draws run on streams of their own and the trait
stream is untouched. `tests/drawn-fields.test.ts` asserts that, and the eight test files that
were here before this change pass unedited.

Bumping the version would therefore describe a change those audiences cannot see, and it would
do real damage: `parseAudience` refuses an audience whose `generatedFrom.generatorVersion` is
not this build's, so every audience stored in the seeded demo workspace — all of them written
by `persona-gen-1` — would stop generating people, and `packages/platform`'s people preview
would answer each one with an issue instead of a swarm. The version is a promise about
reproducibility: _these people are reproducible against that version_. It moves when an
audience that generated one set of people would now generate another. That is what #78 will do
when it regenerates the committed artifact's personas, and it is not what this did.

## 5. The committed preset

`OUTDOOR_GEAR_SHOPPERS` — the demo shop's customers, stated field for field as the prototype's
`AUDIENCE` constant states them, with `size: 4`.

`size` is **how many people the audience generates**, which is what the contract asserts a
run's `personas[]` against (decision 1, on #105). The prototype writes `24` in that field and
means the sessions a test runs: 4 people × 2 versions × 3 seeds. `tests/preset.test.ts` asserts
this object equals the committed example run's own audience block field for field, so the
preset and the demo cannot drift into two different audiences.

## 6. The holdout

`generateHoldout({ audience, spentSeeds, size? })` — people from the same audience, on seeds a
change was never chosen against (`docs/FLOW.md` section 15, point 4).

A path-2 comparison runs the baseline and the change with the same audience and the same seeds,
so the two sides differ only in the code. That is not enough to believe a gain: the change was
chosen by reading those very people, so they are the people it was fitted to. The holdout is the
second reading that cannot agree with itself — the same audience, the same apportionment, the
same arithmetic, other seeds.

```ts
const holdout = generateHoldout({ audience, spentSeeds: run.seedGroups });
// holdout.seeds[i] is the seed holdout.personas[i] was sampled on, and none of them was spent
```

- **Disjoint by construction.** The seeds come from the audience's own candidate sequence with
  every spent candidate stepped over, so no path through the file returns a spent one; a request
  that cannot be met that way is refused with the reason instead of quietly reusing a seed. The
  audience's own `generatedFrom.seed` is spent by definition, because the main set is generated
  from it, and every spent seed is held to being an integer — `undefined >>> 0` is 0, and a spent
  seed taken on trust would mark the wrong stream as spent. Seeds are compared as the **stream**
  they name — `createSeededRandom` starts from `seed >>> 0` — so two integers a multiple of 2³²
  apart are one seed here, not two.
- **The window, and what it means to run out.** The sequence is walked 256 candidates per person
  wanted; without a window, "there is no holdout left here" could only be said after walking 2³²
  candidates. The window is therefore also the ceiling on one audience: a caller that hands back
  every seed it has ever spent on it, rather than the seeds the change in front of it was chosen
  on, can spend the window, and is refused when it does. 256 per person is 256 holdouts of a
  given size with no seed repeated between them. The promise is about the seed, which is where a
  stream starts; `src/holdout.ts` states precisely what that does and does not cover.
- **One seed per person.** `generatePersonas(audience, { seeds })` samples person _i_ from
  `seeds[i]`'s own stream, and refuses two seeds that name one stream: two people sampled from
  one seed are one person twice. It is the only caller of that option.
- **The same kind of person.** The holdout is generated from the same audience object at the
  holdout's size, so the segments, the device mix, the gender split, the age groups, the
  languages and the trait centre are the main set's rules rather than a second apportionment. Only the ids and names differ — `holdout-rushed-buyer`,
  `Rushed buyer (holdout)` — because a run carries the holdout people in its own `personas[]`,
  where a persona id names one simulated person.
- **The size.** `holdoutSize(participants)` is `HOLDOUT_DEFAULT_SIZE`, capped at the audience: a
  fixed 20 whatever the participant count, so a hundred participants give twenty and so do forty,
  and the demo's four give four. It is one named constant in `src/generate.ts`, beside the
  generator's other defaults, and a caller who wants another number passes `size`. It was a share
  — 40 per cent, at least 10 — until the owner's choice on decision 83 made it flat (#318); the
  cap is the part of the share rule that survives, because a holdout larger than the set it
  checks is the comparison the wrong way round. Twenty is a cheap reading and an often
  inconclusive one: the bands frequently cannot separate on twenty people, so "the holdout could
  not judge" is a common answer rather than a rare one, and that is the decision working rather
  than a defect.

Running these people is `@personavision/swarm`'s and recording them is the contract's. Nothing
here knows what a pull request is, and nothing here reads a run.

## Rejecting an audience

`generatePersonas` validates before it samples: a bad audience is an
`AudienceValidationError` carrying `issues: { path, message }[]` — `devices`, `ageRange`,
`generatedFrom.generatorVersion`, or the name of a field the contract does not declare —
rather than a set of people who look plausible and are not. The platform stores audiences a
user typed, so this is the error an audience form reports field by field.

The three fields of section 4 report the same way, at their own paths, so a form can mark the
field the user typed rather than the audience: `genderSplit` for a split that is not a
distribution and `genderSplit.male` for a share that is not a share; `ageGroups` for group
shares that do not sum to one or that disagree with `ageRange`, and `ageGroups[1].group` for
the same bracket declared twice; `languages` for a list that is there but empty and
`languages[0]` for an empty language in it. `tests/drawn-fields.test.ts` pins every one of
those paths.

An audience whose `generatedFrom.generatorVersion` is not this build's `GENERATOR_VERSION` is
rejected, the same promise the artifact's `schemaVersion` makes: its people were reproducible
against that version and would not be against this one. Build an audience with
`GENERATOR_VERSION` rather than with a literal.

A device mix is held to summing to one within the contract's `1e-6`, which is a tolerance and
not an equality, so `size × share` summed over a legal mix need not be `size`: over millions of
people it is out by whole people in either direction. The apportionment repairs that, because
the assignment relies on every person being accounted for to always have a device left to hand
out.

## What a caller sees

`generatePersonas`, `generateHoldout`, `holdoutSize`, `OUTDOOR_GEAR_SHOPPERS`,
`DEMO_AUDIENCE_SEED`, `GENERATOR_VERSION`, `parseAudience` and `AudienceValidationError` — and
nothing else. The archetype table, the
trait centres and the device apportionment are the derivation rather than an interface: this
file states their choices and `tests/` reaches them by module, as the engine's own tests do.
`tests/boundaries.test.ts` asserts that list, so behaviour cannot join the interface without
somebody reading why.

## Properties

No file, no socket, no environment read, no `Math.random`: every draw comes from the contract's
seeded generator. `tests/boundaries.test.ts` holds that over the sources, and holds the
package to generation — no sampling parameter and no decision logic here.
