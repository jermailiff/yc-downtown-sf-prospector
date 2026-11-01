# YC Downtown SF Prospector

A small Node.js script that reads Tandem Space's public YC company map, filters its San Francisco listings by selected downtown-area neighborhood labels, and looks for public email addresses on company homepages. Results are written locally as CSV and JSON.

## Requirements

- Node.js 18 or later with built-in `fetch`.
- Internet access to Tandem and the company websites.
- No API key or third-party packages are needed.

## Run

```sh
node scripts/prospect.js --limit 10 --concurrency 3
```

Remove `--limit 10` for the full list. `--concurrency` controls the number of simultaneous lookups (default: 16). Each run writes `output/tandem_sf_downtown_founders.csv` and a matching JSON file. **A new run overwrites these output files.** The output folder is excluded from Git so generated contacts stay local.

The CSV includes company name, address, neighborhood, website, a public email when found, and the page where it was found. Email matches can include support, sales, or individual addresses; check the source before outreach.

## Scope and accuracy

The filter includes Civic Center, Embarcadero, FIDI, Jackson Square, Mid Market, Mission Bay, SOMA, South Beach, South FiDi, Tenderloin, Union Square, and Yerba Buena, using Tandem's labels. These are prospecting candidates, not independently verified current headquarters. A listing can be stale, a mailing address, outside your definition of downtown, or no longer active. Verify the company and location before contacting it.

Email extraction checks homepage HTML only. It may miss addresses or find unrelated, outdated, or non-deliverable ones. It does not verify inboxes or send email. Sites may block automated requests. Respect site terms and applicable outreach rules.

Optional `--experimental-founders` searches public snippets for possible founder names. These guesses can be wrong or refer to a CEO who is not a founder; independently verify every name and source. Founder search is disabled by default. `--skip-founders` explicitly retains the default. Offset resume is disabled because directory ordering and partial checkpoints are not stable.

The directory comes from embedded page data rather than an official API, so changes to Tandem's site can break the parser. This project is independent of Tandem and Y Combinator.

## Development

```sh
npm test
```

The code is available under the [MIT License](LICENSE).
