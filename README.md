# Locals Calendar Builder

A small GitHub Pages site that turns the weekly Pokémon locals schedule into an
`.ics` file you can import into Google Calendar.

1. **Paste the schedule.** Lines like `10/3 12:00pm Chal @ PsychoTurtle (Pico Rivera)`
   become events. Note lines like `— 10/10-11 Louisville Regionals —` become
   all-day events (you can turn that off in Settings). Any line the page can't
   read is listed instead of being dropped silently.
2. **Confirm locations.** Stores you've confirmed before are reused. New stores
   are looked up by name and city and shown on a map, with a Google Maps link to
   check each one. Nothing is exported until every location is ticked as correct.
3. **Review the changes** against the last calendar: new events, changed ones
   (with the old and new time, title or location), and upcoming events that
   dropped off the schedule (left out unless you tick *Keep it anyway*). Past
   events are carried over as history.
4. **Download the `.ics`**, then import it into Google Calendar.

## Putting it into Google Calendar

On a computer, go to Google Calendar → ⚙ Settings → **Import & export**, drop the
file onto *Select file from your computer*, choose your locals calendar, then **Import**.

Each event has a permanent ID (date + store), so re-importing into the same
calendar updates events that moved instead of duplicating them. Google's import
never deletes events, though, so either delete the events the page lists under
*No longer on the schedule*, or, for an exact replacement, delete the locals
calendar, create a fresh one, and import the file into it.

**Hands-off option:** turn on *Publish to GitHub* (below) and subscribe once in
Google Calendar with *Other calendars → + → From URL* using
`https://<owner>.github.io/<repo>/calendar.ics`. Google re-reads that link on its
own every several hours, including removals.

## Hosting it on GitHub Pages

1. Push this folder to a GitHub repo.
2. In the repo, go to **Settings → Pages**, choose *Deploy from a branch*,
   pick `main` and `/ (root)`, then save.
3. The site appears at `https://<owner>.github.io/<repo>/`.

## Where things are remembered

- **This browser** keeps the last exported calendar and the stores you've
  confirmed, so next week only brand-new stores need checking.
- **The calendar itself** stores each store's address, so opening an older
  `.ics` (button or drag-and-drop) teaches the page those stores too.
- **Optional, the repo:** with *Publish to GitHub* set up in Settings, the page
  commits `calendar.ics` and `venues.json` to the repo, so every device compares
  against the same last calendar. It needs a
  [fine-grained token](https://github.com/settings/personal-access-tokens/new)
  limited to this one repo with **Contents: Read and write**. The token is kept
  in your browser only if you tick *Remember*.

## Notes

- Times are Pacific (`America/Los_Angeles`). Every event is 3 hours long
  (change it in Settings); note lines like Regionals are all-day events.
- The schedule doesn't include a year, so each date gets the year closest to
  the "Updated" date (a December schedule's January events land in the next year).
- Store lookups use Esri's public ArcGIS geocoder, which knows most game stores
  by name. When it only finds the city, the event's location is
  "Store, City, CA", which Google Maps still resolves when you tap it.

## Development

```sh
npm test            # parser, iCal and diff tests (Node 18+)
npm run serve       # http://localhost:8000 (the page must be served, not opened as a file)
```

`sample-schedule.txt` holds the schedule used by the tests.
