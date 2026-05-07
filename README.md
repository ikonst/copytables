# Installing

1. Clone the repo
2. `npm install`
3. `npm run build`
4. Go to chrome://extensions, select **Load Unpacked** and navigate to the repo root

# Usage

- Select a rectangular range like in a spreadsheet:
  - Hold **Ctrl** (**Shift** on MacOS), click then drag
  - Hold **Ctrl** (**Shift** on MacOS), click one corner then the opposing corner

- Copy as usual (Ctrl/Cmd-C)

# Features

- Requires data tables (must contain header) either defined with `<table>`, `<tr>`, `<th>`, `<td>` or ARIA roles `grid`, `row`, `columnheader`, `datacell`, etc.
- Copies virtualized tables by scrolling rows into view
- Even if you didn't select it, prepends the header to the copied table
- Copies TSV (text/plain) — recognized by Slack, and HTML table (text/html) — preferred by everything else
