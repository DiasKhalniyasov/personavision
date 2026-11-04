# Navigation fixture pages

Three pages for the case a page **navigates while it is being read** (#419).

They are here rather than in `../site/` for the reason that site's `LANDMARKS.md` gives: it
is shared by six tickets of the browser-driving step, and a ticket that needs a case those
pages do not have adds it under its own directory. `serveFixtureSite({ root })` serves this
one, exactly as it serves `../one-site/`.

| page                 | what it is                                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `navigates.html`     | The page a session lands on. `window.pvNavigateIn(ms, holdMs)` schedules a `setTimeout` location change.              |
| `destination.html`   | Where that navigation lands: the page a re-read capture describes.                                                    |
| `redirect-loop.html` | A page that answers every load with another navigation, so a read of it never finishes on the document it started on. |

The navigation is **scheduled by the reader** rather than fired on load, because what the
capture has to survive is a navigation that lands _during_ it: a page that bounced before the
first read is simply a capture of the destination and proves nothing. The test calls
`pvNavigateIn(0, 300)` as it starts the capture.

`holdMs` is the second half of that timing, and it is what makes the case real on one
machine. A destination served from loopback answers in about a millisecond, so the new
document commits in the gap _between_ two reads — where nothing is reading, nothing is
destroyed and the capture simply measures the destination. On the web the commit takes a
network away and lands on a read in flight, which is what destroys the context. Holding the
page's main thread for a moment after asking to navigate reproduces that locally: the
capture's reads queue behind the hold, and the document they were to run in is gone by the
time the thread is free. With it, the capture of `navigates.html` is composed exactly twice
every time.

`redirect-loop.html` bounces to itself under a new URL (`?n=`), so each load is a real
navigation rather than a same-document one; `?ms=` is the gap between them, 25ms by default.
Two destroyed contexts in one capture is what it provokes, and the capture raises the second
one rather than re-reading for ever — `capture.ts` re-reads once, and the session budget's
caps end the session.

What came of these pages is in `../../capture.test.ts`. On `main` before #419 the first
destroyed execution context travelled to the session budget, which retried the whole capture
twice and ended the session as an automation failure: five of six sessions over
`www.canva.com` were lost that way, with Playwright's own sentence as the reason.
