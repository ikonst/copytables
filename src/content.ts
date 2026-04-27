interface Grid {
  root: HTMLElement;
  rowCount: number;
  colCount: number;
  cellAt(r: number, c: number): HTMLElement | null;
  rowElement(r: number): HTMLElement | null;
  isHeaderRow(r: number): boolean;
}

interface Coords {
  grid: Grid;
  row: IndexWithOffset;
  col: IndexWithOffset;
}

interface IndexWithOffset {
  index: number;
  offset: number; // offset in pixels from the top/left of the grid, used for scrolling into view
}

interface SelectionRect {
  grid: Grid;
  minRow: IndexWithOffset;
  maxRow: IndexWithOffset;
  minCol: IndexWithOffset;
  maxCol: IndexWithOffset;
}

const selection: { anchor: Coords | null; focus: Coords | null } = {
  anchor: null,
  focus: null,
};
let dragging = false;
let observer: MutationObserver | null = null;

function makeTableGrid(table: HTMLTableElement): Grid {
  const allRows = Array.from(table.rows);
  const rowCells = allRows.map((tr) => Array.from(tr.cells));
  return {
    root: table,
    rowCount: allRows.length,
    colCount: Math.max(0, ...rowCells.map((r) => r.length)),
    cellAt(r: number, c: number): HTMLElement | null {
      const row = allRows[r - 1];
      if (row) {
        const cell = rowCells[r - 1][c - 1];
        if (cell) {
          return cell;
        }
      }
      return null;
    },
    rowElement(r: number): HTMLElement | null {
      return allRows[r - 1] || null;
    },
    isHeaderRow(r: number): boolean {
      const tr = allRows[r - 1];
      if (!tr) return false;
      if (tr.closest("thead")) return true;
      const cells = Array.from(tr.cells);
      return cells.length > 0 && cells.every((c) => c.tagName === "TH");
    },
  };
}

function makeAriaGrid(gridEl: HTMLElement): Grid {
  function* rowIterator(): Generator<{
    row: HTMLElement;
    rowIndex: number;
  }> {
    let rowIndex = 0;
    for (const el of gridEl.querySelectorAll('[role="row"]')) {
      const row = el as HTMLElement;
      if (row.ariaRowIndex !== null) {
        const nextRowIndex = Number(row.ariaRowIndex);
        if (nextRowIndex > rowIndex) {
          rowIndex = nextRowIndex;
        } else {
          console.warn(
            "Non-sequential aria-row-index values detected. This may cause incorrect behavior.",
          );
        }
      } else {
        rowIndex++;
      }
      yield { row, rowIndex };
    }
  }

  function* cellIterator(row: HTMLElement): Generator<{
    cell: HTMLElement;
    colIndex: number;
  }> {
    let colIndex = 0;
    for (const el of row.querySelectorAll(
      '[role="gridcell"], [role="columnheader"]',
    )) {
      const cell = el as HTMLElement;
      if (cell.ariaColIndex !== null) {
        const nextColIndex = Number(cell.ariaColIndex);
        if (nextColIndex > colIndex) {
          colIndex = nextColIndex;
        } else {
          console.warn(
            "Non-sequential aria-col-index values detected. This may cause incorrect behavior.",
          );
        }
      } else {
        colIndex++;
      }
      yield { cell, colIndex };
    }
  }

  function rowElement(r: number): HTMLElement | null {
    for (const { row, rowIndex: ri } of rowIterator()) {
      if (ri === r) {
        return row;
      }
    }
    return null;
  }

  return {
    root: gridEl,
    rowCount: Number(gridEl.ariaRowCount),
    colCount: Math.max(
      0,
      ...Array.from(gridEl.querySelectorAll('[role="row"]')).map((row) =>
        Number(row.ariaColCount),
      ),
    ),
    cellAt(r: number, c: number): HTMLElement | null {
      for (const { row, rowIndex } of rowIterator()) {
        for (const { cell, colIndex } of cellIterator(row)) {
          if (rowIndex === r && colIndex === c) {
            return cell;
          }
        }
      }
      return null;
    },
    rowElement,
    isHeaderRow(r: number): boolean {
      const row = rowElement(r);
      if (!row) return false;
      const cells = Array.from(
        row.querySelectorAll('[role="gridcell"], [role="columnheader"]'),
      );
      if (cells.length === 0) return false;
      return cells.every((c) => c.role === "columnheader");
    },
  };
}

function findGrid(el: Element): Grid | null {
  const table = el.closest("table");
  if (table) return makeTableGrid(table);
  const gridEl = el.closest('[role="grid"]');
  if (gridEl) return makeAriaGrid(gridEl as HTMLElement);
  return null;
}

function cellCoords(el: Element): Coords | null {
  const td = el.closest("td, th") as HTMLTableCellElement | null;
  if (td) {
    const table = td.closest("table");
    if (table) {
      const grid = makeTableGrid(table);
      const tr = td.closest("tr");
      if (!tr) return null;
      const allRows = Array.from(table.rows);
      const rowIndex = allRows.indexOf(tr);
      const colIndex = Array.from(tr.cells).indexOf(td);
      if (rowIndex === -1 || colIndex === -1) return null;
      return {
        grid,
        row: {
          index: rowIndex,
          offset: tr.offsetTop,
        },
        col: {
          index: colIndex,
          offset: td.offsetLeft,
        },
      };
    }
  }
  const ariaCell = el.closest(
    '[role="gridcell"], [role="columnheader"]',
  ) as HTMLElement | null;
  if (ariaCell) {
    const gridEl = ariaCell.closest('[role="grid"]') as HTMLElement | null;
    if (gridEl) {
      const grid = makeAriaGrid(gridEl);
      const ariaRow = ariaCell.closest('[role="row"]') as HTMLElement | null;
      if (ariaRow) {
        return {
          grid,
          row: {
            index: Number(ariaRow.ariaRowIndex),
            offset: ariaRow.offsetTop,
          },
          col: {
            index: Number(ariaCell.ariaColIndex),
            offset: ariaCell.offsetLeft,
          },
        };
      }
    }
  }
  return null;
}

function clearSelection(): void {
  document.querySelectorAll(".copytables-selected").forEach((el) => {
    el.classList.remove("copytables-selected");
  });
}

function getRect(): SelectionRect | null {
  const { anchor, focus } = selection;
  if (!anchor || !focus || anchor.grid.root !== focus.grid.root) return null;
  const grid = findGrid(anchor.grid.root);
  if (!grid) return null;

  let minRow = anchor.row;
  if (focus.row.index < minRow.index) {
    minRow = focus.row;
  }
  let maxRow = anchor.row;
  if (focus.row.index > maxRow.index) {
    maxRow = focus.row;
  }
  let minCol = anchor.col;
  if (focus.col.index < minCol.index) {
    minCol = focus.col;
  }
  let maxCol = anchor.col;
  if (focus.col.index > maxCol.index) {
    maxCol = focus.col;
  }

  return {
    grid,
    minRow,
    maxRow,
    minCol,
    maxCol,
  };
}

function disconnectObserver(): void {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
}

function observeGrid(): void {
  disconnectObserver();
  if (!selection.anchor) return;
  observer = new MutationObserver(() => {
    highlightSelection();
  });
  observer.observe(selection.anchor.grid.root, {
    childList: true,
    subtree: true,
  });
}

function highlightSelection(): void {
  disconnectObserver();
  clearSelection();
  const rect = getRect();
  if (!rect) return;
  for (let r = rect.minRow.index; r <= rect.maxRow.index; r++) {
    for (let c = rect.minCol.index; c <= rect.maxCol.index; c++) {
      const cell = rect.grid.cellAt(r, c);
      if (cell) {
        cell.classList.add("copytables-selected");
      }
    }
  }
  observeGrid();
}

document.addEventListener("mousedown", (e: MouseEvent) => {
  if (!(e.target instanceof Element)) return;
  const coords = cellCoords(e.target);
  if (!coords) {
    if (selection.anchor) {
      clearSelection();
      disconnectObserver();
      selection.anchor = null;
      selection.focus = null;
    }
    return;
  }

  if (
    e.shiftKey &&
    selection.anchor &&
    selection.anchor.grid.root === coords.grid.root
  ) {
    e.preventDefault();
    selection.focus = coords;
  } else {
    selection.anchor = coords;
    selection.focus = coords;
    dragging = true;
  }
  highlightSelection();
});

document.addEventListener("mousemove", (e: MouseEvent) => {
  if (!dragging || !selection.anchor || !selection.focus) return;
  if (!(e.target instanceof Element)) return;
  const coords = cellCoords(e.target);
  if (!coords || coords.grid.root !== selection.anchor.grid.root) return;
  if (
    coords.row !== selection.focus.row ||
    coords.col !== selection.focus.col
  ) {
    e.preventDefault();
    selection.focus = coords;
    highlightSelection();
  }
});

document.addEventListener("mouseup", () => {
  dragging = false;
});

function cellText(cell: HTMLElement | null): string {
  return cell ? cell.innerText.trim() : "";
}

function cellHTML(cell: HTMLElement | null): string {
  if (!cell) return "<td></td>";
  const isHeader = cell.tagName === "TH" || cell.role === "columnheader";
  const tag = isHeader ? "th" : "td";
  return `<${tag}>${cell.innerHTML}</${tag}>`;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function collectRows(
  rect: SelectionRect,
): Promise<{ tsv: string; html: string }> {
  const grid = rect.grid;
  const tsvLines: string[] = [];
  const htmlLines: string[] = [];
  let headHtml = "";

  const headerRows: number[] = [];
  for (let r = 1; r <= grid.rowCount; r++) {
    if (grid.isHeaderRow(r)) headerRows.push(r);
    else break;
  }

  if (headerRows.length > 0 && rect.minRow.index > headerRows[0]) {
    const headRowsHtml: string[] = [];
    for (const r of headerRows) {
      const tsvCols: string[] = [];
      const htmlCols: string[] = [];
      for (let c = rect.minCol.index; c <= rect.maxCol.index; c++) {
        const cell = grid.cellAt(r, c);
        tsvCols.push(cellText(cell));
        htmlCols.push(cellHTML(cell));
      }
      tsvLines.push(tsvCols.join("\t"));
      headRowsHtml.push(`<tr>${htmlCols.join("")}</tr>`);
    }
    headHtml = `<thead>${headRowsHtml.join("")}</thead>`;
  }

  let lastCell = grid.cellAt(rect.minRow.index, rect.minCol.index);
  if (lastCell === null) {
    grid.root.scrollTo({ top: rect.minRow.offset, behavior: "instant" });
    for (let attempt = 0; lastCell === null && attempt < 10; attempt++) {
      await sleep(100);
      lastCell = grid.cellAt(rect.minRow.index, rect.minCol.index);
    }
  }
  if (!lastCell) {
    console.warn(
      `Could not access first cell at ${rect.minRow.index}:${rect.minCol.index} after multiple attempts.`,
    );
    return { tsv: "", html: headHtml + `<tbody></tbody>` };
  }

  for (let r = rect.minRow.index; r <= rect.maxRow.index; r++) {
    const tsvCols: string[] = [];
    const htmlCols: string[] = [];

    for (let c = rect.minCol.index; c <= rect.maxCol.index; c++) {
      let cell = grid.cellAt(r, c);
      if (!cell && lastCell) {
        grid.root.scrollTo({
          top: lastCell.offsetTop + lastCell.offsetHeight,
          behavior: "instant",
        });
        for (let attempt = 0; cell === null && attempt < 10; attempt++) {
          await sleep(100);
          cell = grid.cellAt(r, c);
        }
      }
      if (cell === null) {
        console.info(
          `Cell at ${r}:${c} not found after retries, leaving blank.`,
        );
      }
      tsvCols.push(cellText(cell));
      htmlCols.push(cellHTML(cell));
      if (cell) lastCell = cell;
    }
    tsvLines.push(tsvCols.join("\t"));
    htmlLines.push(`<tr>${htmlCols.join("")}</tr>`);
  }

  const tsv = tsvLines.join("\n");
  const html = `<table>${headHtml}<tbody>${htmlLines.join("")}</tbody></table>`;
  return { tsv, html };
}

document.addEventListener("copy", async (e: ClipboardEvent) => {
  const rect = getRect();
  if (!rect) {
    return;
  }

  e.preventDefault(); // before we potentially return a promise
  const { tsv, html } = await collectRows(rect);
  try {
    // Cannot use setData in async handler, so use Clipboard API directly
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": new Blob([tsv], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" }),
      }),
    ]);
  } catch (err) {
    console.info("Failed to write to clipboard:", err);
  }
});
