# The shadcn/ui registry

Every control in the product is a primitive from here: button, input, label, select, tabs,
table, dialog, dropdown-menu, tooltip, badge, skeleton, separator, toggle, toggle-group,
slider, form. A screen ticket that needs one takes it and restyles nothing.

Each file is **the registry's own**, written by

```
pnpm dlx shadcn@latest add <name>
```

from `components.json`. A ticket that needs a primitive this folder does not hold adds it
with that command; it never forks one that is here. The repository's Prettier then formats
what the command wrote, as it formats everything else — `pnpm format:check` gates CI — so
the only _content_ differences from the registry are the four below.

## Where the styling comes from

Nothing here carries a colour, a radius, a type size or a duration of its own. The
Tailwind theme in `../../styles/theme.css` maps every one of those onto
`docs/design/tokens.css`, so `bg-primary` is the lime action colour, `rounded-xl` is the
20px card radius, and a token edit moves the whole product. `apps/viewer/tests/theme.test.tsx`
asserts that.

## The four departures from the registry's own classes

`docs/FLOW.md` section 10 asks for things the registry does not do by default. Each is a
class, not a rewrite, so these files still track the registry:

1. **`button.tsx`: `rounded-md` → `rounded-full`.** Every button, chip and tag in this
   product is fully rounded; it is one of the direction's most visible fingerprints.
2. **`ring-[3px]` → `ring-[length:var(--border-width-strong)]`** wherever the registry
   draws a focus ring. Focus is always visible at `--border-width-strong` in
   `--color-focus`. The `length:` hint is needed: an arbitrary value after `ring-` reads as
   a ring _colour_, and `cn` would then drop it as conflicting with `ring-ring/50`.
3. **`dialog.tsx`: `duration-200` removed.** A component never writes its own duration:
   with it gone the dialog inherits `--default-transition-duration`, which the theme maps
   onto `--duration-base` — and that token is `0ms` under `prefers-reduced-motion`.
4. **`bg-accent` / `text-accent-foreground` → `bg-secondary` /
   `text-secondary-foreground`,** wherever a primitive hovers or selects. The registry's
   `accent` is a hover tint; `--color-accent` is the tokens' name for the **lime action
   colour**, and a Tailwind theme entry of that name is declared in the document, where it
   would shadow the token the whole product reads. `secondary` is the same pale panel with
   heading-strength text and collides with nothing. `tests/theme.test.ts` asserts that the
   app declares no token's name, so a primitive added later that reaches for `bg-accent`
   fails there rather than quietly washing the product in lime.
