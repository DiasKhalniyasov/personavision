# One-site fixture pages

Two pages for the case a **derived** step is: a test of one URL, where nobody declared a
control, and the step stands for the whole site (#418).

They are here rather than in `../site/` because that site is shared by six tickets of the
browser-driving step and its `LANDMARKS.md` says so: a ticket that needs a case those pages
do not have adds it under its own directory. `serveFixtureSite({ root })` serves this one.

Both pages are what the owner's five real one-site runs hit, reduced to the smallest markup
that still hits it. On `main` before #418 the derived step declared the page's first control
as its primary action — the first of a button, a submit input, a link, or anything carrying a
button role — and `resolvePrimaryAction` refused every screen of both pages:

| page               | what the stand-in selector resolved to                                                                                     | the failure it raised            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `skip-link.html`   | the visually hidden skip link, the only one of the four kinds on it: a real box, 1x1, that no extracted candidate occupies | none of the N candidate elements |
| `no-controls.html` | nothing: the page has no control of any of the four kinds                                                                  | absent                           |

So neither page carries a control a person could have been sent for, which is the point:
a derived step declares no primary action, nothing is probed, and the screen is captured
with its elements and none of them marked.

Each page is taller than the 900px desktop viewport, for the reason `../site/LANDMARKS.md`
gives: a page shorter than the viewport reports the viewport's height as its own, and its
page height would then differ between the two viewports.
