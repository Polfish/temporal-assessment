# Evidence

`fill-opening-workflow.png` is the Temporal Web UI for one representative run, `opening-1b0c8322`
(a Haircut with Carla, 1-minute offer window for the demo):

1. Maya was offered the chair and did not reply; the 1-minute timer fired.
2. Priya was offered the chair next (second `sendSms` Activity).
3. Maya replied YES late: the `respondToOffer` Update was accepted by the Workflow, refused as too late, and
   a "sorry, already taken" text was sent.
4. Priya replied YES: the Update completed with `accepted: true`, the offer timer was cancelled, the
   confirmation text was sent, and a new timer now holds the chair until the appointment time.

The Workflow is still **Running** in the screenshot because it holds the filled chair until staff mark it
booked in Square. All names and phone numbers are fictional seed data.
