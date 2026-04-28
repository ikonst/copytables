# Installing

1. Clone the repo
2. `npm install`
3. `npm build`
4. Go to chrome://extensions, select **Load Unpacked** and navigate to the repo root

# Usage

- Two ways to select:
  - Click then drag
  - Click then Shift-Click opposite end

# Features

- Requires data tables (must contain header) either defined with `<table>`, `<tr>`, `<th>`, `<td>` or ARIA roles `grid`, `row`, `columnheader`, `datacell`
- Copies virtualized tables by scrolling rows into view
- Prepends the header
- Copies TSV (text/plain) — recognized by Slack, and HTML table (text/html) — preferred by everything else
