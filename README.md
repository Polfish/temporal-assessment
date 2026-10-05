# Juniper Salon: fill a cancelled chair

A prototype for Lena, who runs Juniper Salon. When a client cancels, the front desk currently checks a
Google Sheet of people who asked for an earlier appointment and texts several of them at once from the
salon phone. Nobody tracks who was contacted or when, two people sometimes say yes to the same chair,
and if nobody answers the chair stays empty.

This prototype turns that into one durable process per opening, run by [Temporal](https://temporal.io):

- the chair is offered to **one matching client at a time**, in a defined order;
- each person gets a bounded window to answer (Lena's numbers: 15 minutes for same-day, 60 otherwise);
- no reply or a "no" moves to the next person, and they stay on the waitlist;
- a "yes" sends a confirmation and holds the chair until staff book it in Square;
- a late "yes" from someone whose turn has passed is refused with a polite text;
- staff can skip someone, record a reply by hand, release a client who changed their mind, or cancel;
- the process stops by itself when the appointment time arrives.

## Run it

Requirements: Node.js 20 or newer and Docker Desktop (running).

```bash
npm install
npm run dev
```

Then open <http://localhost:3000>. The Temporal Web UI is at <http://localhost:8233>.

`npm run dev` starts the Temporal dev server in Docker, the Worker, and the API. `npm run stop` stops
the Temporal container.

## 60-second demo

1. In **New opening**, pick *Haircut* with *Carla*, set the **offer window** to `1` minute (so you don't
   wait fifteen), and click **Start filling this chair**. The form already shows who will be contacted
   and in what order.
2. The opening appears with Maya holding the offer and a countdown. The **Client phone** panel on the right
   shows the text she received.
3. Let the minute run out. Maya is marked *No reply in time* and Priya is texted next.
4. In the client phone, switch to **Maya** and press **Reply YES**. She is told the chair has already been
   offered to someone else. Priya still holds the only offer.
5. Switch to **Priya** and press **Reply YES**. The opening turns *Filled*, Priya gets a confirmation
   text, and staff see **Mark booked in Square** and a release button in case she changes her mind.
6. Open <http://localhost:8233> and click the opening's Workflow (its ID starts with `opening-`) to see the
   timer, the Update, and each simulated text as an Activity in the event history.

Also try **Cancel opening** while someone holds the offer: they get a withdrawal text and nothing else
is ever sent for that opening.

## Tests

```bash
npm test
```

Five Workflow tests run against Temporal's time-skipping test server (no Docker needed): first client
accepts and is booked; first client times out and the next is offered; a late YES is refused; a released
client is withdrawn and the search resumes; cancelling stops everything.

```bash
npm run typecheck
```

## How it uses Temporal

| Need from the conversation | Temporal piece | Where |
| --- | --- | --- |
| One opening, one process, never two offers out at once | One Workflow execution per opening; the Workflow ID is the opening ID and duplicate starts are rejected | `fillOpeningWorkflow` in [src/workflows.ts](src/workflows.ts), started in [src/api.ts](src/api.ts) |
| Give each person about 15 minutes, then move on | `condition(..., timeout)` on a durable timer, clamped so an offer never outlives the opening | `src/workflows.ts` |
| Client replies, including late ones that must be refused | `respondToOffer` **Update**: validated against who currently holds the offer, returns a result the UI shows | `src/workflows.ts`, `POST /api/openings/:id/reply` |
| Staff controls: skip, cancel, release, booked | **Signals** | `src/workflows.ts`, `POST /api/openings/:id/{skip,cancel,release,booked}` |
| Front desk sees the opening, who holds the offer, who is next, every text | `getOpeningStatus` **Query**; the dashboard lists openings straight from Temporal's visibility API | `GET /api/openings`, [public/app.js](public/app.js) |
| Stop when the opening disappears or the time arrives | Cancel Signal checked at every step; the hold and every offer window are bounded by the start time | `src/workflows.ts` |
| Send texts | `sendSms` **Activity** (simulated: logs and returns) with a retry policy | [src/activities.ts](src/activities.ts) |

Workflow state is the only record of an opening's progress. The API process keeps nothing in memory
except the seed data; restart it and the dashboard rebuilds from Temporal.

## What is simulated or left out

- **Texts are simulated.** The Activity logs the message; the Workflow keeps the outbox so the "client
  phone" panel can show it and let you reply as the client. Swapping in a real SMS provider changes only
  `src/activities.ts`.
- **Square and the Google Sheet are stubbed** with read-only seed data in [src/data.ts](src/data.ts).
  Staff enter the opening by hand; booking the accepted client in Square stays manual, as Lena does today.
- **Matching rule** is a first version: same service, respect "required" stylist, prefer people who asked
  for this stylist, then earliest signup. General availability is shown to staff but not used to filter.
- **Not built:** a client holding offers for two openings at once, a "pause and handle by hand" mode,
  editing the waitlist in the app, and reports after the fact.

## Repository map

- `src/workflows.ts`: the Workflow, its Signals, Update and Query, and the text templates
- `src/activities.ts`: the simulated SMS Activity
- `src/api.ts`: Express API and Temporal Client
- `src/data.ts`: seed stylists, services, waitlist, and the ranking rule
- `src/types.ts`: shared types
- `public/`: front-desk dashboard
- `tests/workflow.test.ts`: Workflow tests
- `evidence/`: Temporal Web UI screenshot of a representative run
- `slides/`: the short presentation for Lena
