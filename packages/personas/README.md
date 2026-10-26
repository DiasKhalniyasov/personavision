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

## 4. The committed preset

`OUTDOOR_GEAR_SHOPPERS` — the demo shop's customers, stated field for field as the prototype's
`AUDIENCE` constant states them, with `size: 4`.

`size` is **how many people the audience generates**, which is what the contract asserts a
run's `personas[]` against (decision 1, on #105). The prototype writes `24` in that field and
means the sessions a test runs: 4 people × 2 versions × 3 seeds. `tests/preset.test.ts` asserts
this object equals the committed example run's own audience block field for field, so the
preset and the demo cannot drift into two different audiences.

## Rejecting an audience

`generatePersonas` validates before it samples: a bad audience is an
`AudienceValidationError` carrying `issues: { path, message }[]` — `devices`, `ageRange`,
`generatedFrom.generatorVersion`, or the name of a field the contract does not declare —
rather than a set of people who look plausible and are not. The platform stores audiences a
user typed, so this is the error an audience form reports field by field.

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

`generatePersonas`, `OUTDOOR_GEAR_SHOPPERS`, `DEMO_AUDIENCE_SEED`, `GENERATOR_VERSION`,
`parseAudience` and `AudienceValidationError` — and nothing else. The archetype table, the
trait centres and the device apportionment are the derivation rather than an interface: this
file states their choices and `tests/` reaches them by module, as the engine's own tests do.
`tests/boundaries.test.ts` asserts that list, so behaviour cannot join the interface without
somebody reading why.

## Properties

No file, no socket, no environment read, no `Math.random`: every draw comes from the contract's
seeded generator. `tests/boundaries.test.ts` holds that over the sources, and holds the
package to generation — no sampling parameter and no decision logic here.
