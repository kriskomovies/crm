# snap CRM — design brief

For a designer with no access to the code. Everything below is what the product
actually is today, not what it could be.

## What the product is

A rack of Android emulators, each logged into a burner Snapchat account, screenshots
its own Quick Add roster and uploads the images here. This server reads them with a
vision model, filters who is worth following, and hands each account a metered list of
people to follow. The emulators are a separate project and talk to this one over HTTP
only.

This app is the **operator console** for that machine. One person watches a fleet they
never touch directly. The whole product is a ledger of people, a set of rate limits,
and enough numbers to tell whether the fleet is alive.

## Who the operator is

One person, or a very small agency. An operations person, not an analyst. They are
running something slightly adversarial against a platform that bans accounts for moving
too fast, so their dominant anxiety is **account death** — not growth, not conversion.

They open the app to answer, in this order:

1. **Is anything stalled or maxed out?** Are the machines still uploading, and is any
   account at its daily cap?
2. **Why is this account getting so few people?** Did the filter eat them, or does a
   sibling account already have them?
3. **Who have I actually acquired?** The list of followed people is the one thing of
   value the system produces, and they want to take it out and use it elsewhere.
4. **What is it costing me?** Weekly, not daily.
5. **Am I pushing too hard?** Rarely, and only deliberately — usually after something
   went wrong.

The app is meant to be **left open on a second monitor** and glanced at. The overview
refreshes itself every 5 seconds; the long lists deliberately never refresh, because
re-fetching would throw away what the operator has scrolled to. It is also checked from
a phone, away from the desk, while the machines run unattended.

## Domain vocabulary — get these words right

Wrong words here is the most likely way a redesign fails. These are the operator's own
terms and they appear in the UI verbatim.

| Word | One line |
|---|---|
| **personality** | A persona several accounts share (e.g. `kris`, `mia`). It is also the scope of deduplication — the unit that owns a ledger of people. |
| **account** | One Snapchat login on one emulator. Belongs to exactly one personality. Named by the machine itself, from the handle on its own profile screen. |
| **handle** | A Snapchat username, e.g. `@iraxcvp`. Shown in monospace, `@` prefixed. |
| **display name** | The free-text name on a profile, read off a screenshot by the vision model. Can be anything — emoji, punctuation, blank. |
| **sheet** | One uploaded contact-sheet screenshot of a Quick Add roster. ~1.2 MB, read exactly once, then usually deleted. |
| **target / person** | Someone in a personality's ledger. Attached either by extraction (a sheet) or manually (pasted in). |
| **queued** | Attached to an account, waiting to be handed out. |
| **handed out** | Given to a machine, result not yet reported. A transient internal state. |
| **followed** | The machine reported a successful follow. Terminal. |
| **failed / skipped** | Reported back as unfollowable — e.g. no longer on the roster. Terminal. |
| **rejected** | The filter dropped this person. There is no row, no reason and no screen for them — a rejection is an absence. A **property of the personality**, identical on every account row of that personality. |
| **already followed** | Someone a *sibling* account of the same personality already followed, so this account can never be given them. This is the dedupe the product exists for. |
| **daily cap** | Targets handed to *each* account per day. One number for the whole client. |
| **session cap / window** | The most one account is handed in a rolling window of N minutes. |
| **pace** | Seconds a machine waits between follows. |

## The shape of the data

- **Personalities:** a handful. Two or three is normal; a dozen is a lot.
- **Accounts per personality:** one to ten. The layout should hold ten rows comfortably.
- **People per ledger:** hundreds on day one, tens of thousands after a month of running.
- **Sheets:** the design target is 20,000 a day across a fleet. The extraction log is the
  fastest-growing table in the app.

**Long tables are the central layout problem.** Every list is cursor-paged with a
`Load more` button — never page numbers, never a total row count, because counting the
whole ledger on every request is a cost that grows with the ledger. Design for a list
that has no known length.

## Every screen

There is **no router and no URL** — a tab is state, and the browser back button does
nothing. Five tabs, one drill-in, one full-screen gate.

**Sign in** — full-screen card. `snap CRM`, "Operator sign in", username, password, one
error box. Nothing renders until the session answer lands, so a signed-in operator never
sees the login flash past.

**Chrome** — a topbar with `Follow targets`, a 7px status dot (green connected / red with
the error in its tooltip), and the nav. Below it a global error banner and a `loading…`
line.

**Personalities — the most important screen.** A create-personality form, then a card per
personality: name, a `client · model · N handles attached` line, `View handles` and
`Add account` buttons, and a table of accounts. Per account row: label (monospace), a
**daily cap progress bar** that turns red at the cap, then right-aligned counts, then a
single `pause / resume` link. Paused rows are dimmed to 50%. Empty state: "No accounts
yet — this personality cannot be handed any targets until it has one."

The cap bar is given more room than the numbers on purpose: **it is the safety feature**.
Everything else on this screen is reference; that bar is the thing being watched.

*The counts on this row are changing:* `queued`, `followed`, `rejected`, `already followed`.
`handed out` is being removed — it is a transient internal state that answers nothing.
Note the design problem this creates: `rejected` is a personality-level number, so it will
print the same value on every row of a card. Four right-aligned integers of which one
repeats down the column is a smell worth solving, not shipping.

**Handles (drill-in from "View handles")** — breadcrumb back, personality name, handle
count. A collapsed `Attach handles` panel (paste one per line or comma separated, `@`
optional; the result reads "N added / N already attached / N queued to an account" plus an
amber list of anything rejected as not a handle). Then a toolbar — search box, state
filter, "N shown" — and a table: handle · display name · origin (with a confidence suffix)
· source (extraction or manual, manual marked in violet) · state (as a coloured pill) ·
account. `Load more` at the bottom.

**Followed (new)** — a page listing everyone actually acquired, with **export**. This is
deliverable #3 and does not exist yet. It is the same long-table problem plus a download.

**Stats** — a personality filter, a 7/30/90-day segmented control. Six KPI tiles: sheets ·
profiles read · targets attached · spend (+ token count) · follows (+ failed/skipped) ·
follow success rate. A hand-rolled SVG bar chart by day with a metric switcher, where every
bar sits in a full-height track so an empty range reads as empty rather than broken. An
extraction-vs-manual split bar. Then four tables: by personality, by account (with cap
bars), by country, by model.

**Sheets** — a read-only extraction log. Received · account · status pill · profiles read ·
new handles · seconds · cost · model. A failed sheet shows its error in red under the pill.
Zero new handles is rendered muted with a tooltip — "already held by this personality —
deduped" — because a zero there is the ledger working, not a failure. No actions at all.

**Targeting** — who gets forwarded. Four groups of pill-shaped toggle chips: presents as ·
name origin · skin tone · minimum confidence. Each group carries a dense paragraph of
measured evidence. Save, plus "Applies to the next sheet extracted."

**Settings** — four number fields, each a small right-aligned input beside a paragraph of
prose: follow cap · session cap · window minutes · seconds between follows.

## What the current UI gets right

**It says which numbers are enforced and which are merely served.** Settings states, in
the copy itself, that the two caps are enforced by this server — a machine that ignores
them still gets nothing — while the pace only rides out on the reply and a machine running
an older build will keep using its own config file. That honesty is a *feature*. Preserve
it, and give it visual weight: an enforced limit and a suggestion are different kinds of
object and should not look identical.

**Every explanatory sentence carries a measured number.** "roughly 40 adds/day in testing",
"80 of 99 entries", "about 2%", "leak is about 2%". This operator reads and trusts numbers.
Do not replace this copy with reassuring generalities.

**Zeros are hidden, not printed.** An account with nothing queued shows a blank cell, so
the eye lands only on rows that have something in them.

**Mobile is real, not an afterthought.** Below 720px every table stops being a table: each
row becomes a card and each cell prints its own column heading on the left with the value
pushed right. Nothing depends on a header that has scrolled away. Any new column must
carry its own label or it becomes anonymous on a phone.

**Rates with no attempts behind them show `—`, not `0%`.** Unknown and zero are different.

## Known pain points worth designing away

- **Every drop is silent.** A rejected person leaves no row, no reason and no screen.
  "The filter is working" and "the filter is eating everyone" look identical from here —
  today only a share column buried in the Stats country table exposes the gap. The new
  `rejected` count is the first time that number reaches the main screen, and it deserves
  more weight than a fourth right-aligned integer squeezed next to three others.
- **Targeting is visually broken.** It is the one screen that never got the panel
  treatment — no border, no card, no padding. It will be the first thing a designer
  notices.
- **No deep links.** Nothing in this app has a URL, so nothing can be bookmarked, shared
  or reopened where it was left.
- **The account row is thin.** After the cap bar and the counts, the only action is
  pause/resume — there is no way to see one account's history.
- **A single global dot** is all the health signalling there is. A machine that stopped
  uploading three hours ago looks exactly like one uploading right now.

## Constraints

- **Dark today, must work in both.** The current palette is dark-only: twelve tokens, three
  background planes (page → panel → inset) separated by one hairline, one accent blue for
  chrome, violet for manual provenance, and green/amber/red reserved strictly for state.
  A redesign must define light as well. Roughly thirty colours are currently hardcoded
  outside the tokens — assume the token set needs rebuilding, not extending.
- **Dense numeric tables.** Numeric cells are right-aligned with tabular figures. The most
  repeated type token in the app is an 11px uppercase 600-weight eyebrow used for every
  table header, tile label and mobile cell label.
- **Mobile via label stacking**, as described above. Wide content scrolls inside its own
  box; the page body never scrolls sideways. Breakpoints today: 560, 620, 720.
- **No external fonts, no CDNs.** System font stacks only, one sans and one mono. Charts
  are hand-rolled SVG so the app keeps its two dependencies — assume no charting library.
- **Copy is lowercase and technical.** Column headings are written lowercase and uppercased
  by CSS. This is deliberate register, not an oversight.
