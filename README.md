# Installing

1. Clone the repo
2. `npm install`
3. `npm build`
4. Go to chrome://extensions, select **Load Unpacked** and navigate to the repo root

# Usage

- Two ways to select:
  - Hold **Ctrl** (**Shift** on MacOS), click then drag
  - Hold **Ctrl** (**Shift** on MacOS), click the first cell then the last cell

- Copy as usual (Ctrl/Cmd-C)

# Features

- Requires data tables (must contain header) either defined with `<table>`, `<tr>`, `<th>`, `<td>` or ARIA roles `grid`, `row`, `columnheader`, `datacell`
- Copies virtualized tables by scrolling rows into view
- Prepends the header
- Copies TSV (text/plain) — recognized by Slack, and HTML table (text/html) — preferred by everything else
