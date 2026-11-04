# Single-page application fixture

One page for the case a session's **address changes with no document being loaded** (#441) — the
owner's own run, as a fixture: five sessions over `http://127.0.0.1:5176/` with the criterion
_"The address bar reads /signup."_, where two sessions clicked a react-router `<Link to="/signup">`,
arrived on the sign-up view, and were recorded as `abandoned` with the criterion never observed.
A third did exactly the same thing and was a success. The same click, decided by a race.

It is here rather than in `../site/` for the reason that site's `LANDMARKS.md` gives: it is shared
by six tickets of the browser-driving step, and a ticket that needs a case those pages do not have
adds it under its own directory. `serveFixtureSite({ root })` serves this one, exactly as it serves
`../navigation/` and `../one-site/`.

| page       | what it is                                                                            |
| ---------- | ------------------------------------------------------------------------------------- |
| `app.html` | The only document. Two views, drawn from `window.location.pathname` into one element. |

| address             | the view                                                                          |
| ------------------- | --------------------------------------------------------------------------------- |
| `/app.html`         | The first view, with the control that moves the address to `/signup`.             |
| `/signup`           | The second view. Never requested from the server: nothing loads it.               |
| `/signup-cancelled` | A path that **extends** the one a criterion asks for, and so does not satisfy it. |

Two things about it are deliberate.

**The push happens 50 ms after the click handler, not in it.** A framework resolves its route and
renders before it pushes, so the push lands well after the handler — and after Playwright's click
promise — has returned. Pushing inline, or on the next frame, commits the new address inside the
round trip that reads it, which is the half of the race that already worked: it is what made one of
the owner's three identical sessions a success. 50 ms is far above a loopback round trip and far
below the one second a click is given to move the page, so the address a click reaches is read
correctly only by a wait that resolves on a same-document navigation (`act.ts`'s `following`), and
is read correctly every time by one.

**Nobody has to act for the address to move.** `window.pvMoveIn(ms, path)` moves it on a timer, and
`/app.html?move=/signup` moves it as the document is parsed — so a session opened on that address
lands on a page that is already somewhere else. An address carried from the last action can never
see either navigation, however it is read; a capture that asks the page where it is reads the
address it moved to.

What came of this page is in `../../capture.test.ts`, `../../act.test.ts` and
`packages/swarm/test/run-session.test.ts`.
