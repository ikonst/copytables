interface Grid {
  root: HTMLElement;
  rowCount: number;
  colCount: number;
  cellAt(r: number, c: number): HTMLElement | null;
  rowElement(r: number): HTMLElement | null;
  isHeaderRow(r: number): boolean;
  firstDataCell(): HTMLElement | null;
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
let scrollInterval: number | null = null;

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
    firstDataCell(): HTMLElement | null {
      for (const row of rowCells) {
        for (const cell of row) {
          if (cell.tagName === "TH" || table.tHead?.contains(cell)) {
            break;
          }
          return cell;
        }
      }
      return null;
    },
  };
}

function makeAriaGrid(gridEl: HTMLElement): Grid {
  function* rowIterator(): Generator<{
    row: HTMLElement;
    rowIndex: number;
  }> {
    let rowIndex = 0;
    for (const row of gridEl.querySelectorAll<HTMLElement>('[role="row"]')) {
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
    for (const cell of row.querySelectorAll<HTMLElement>(
      '[role="gridcell"], [role="columnheader"]',
    )) {
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
    firstDataCell(): HTMLElement | null {
      for (const { row } of rowIterator()) {
        for (const { cell } of cellIterator(row)) {
          if (cell.role === "columnheader") {
            break;
          }
          return cell;
        }
      }
      return null;
    },
  };
}

function findGrid(el: Element): Grid | null {
  const table = el.closest("table");
  if (table) {
    if (!table.querySelector("th")) {
      // Chromium has nice heuristic for it: https://source.chromium.org/chromium/chromium/src/+/main:third_party/blink/renderer/modules/accessibility/ax_node_object.cc;l=1951-2191?q=return%20Role::kLayoutTable&ss=chromium%2Fchromium%2Fsrc
      // but there's no public API to get the computed ARIA role yet, so we'll settle for this:
      return null; // treat tables without <th> as "layout tables"
    }
    return makeTableGrid(table);
  }
  const ariaGrid = el.closest<HTMLElement>('[role="grid"]');
  if (ariaGrid) return makeAriaGrid(ariaGrid);
  return null;
}

function cellCoords(el: Element): Coords | null {
  const td = el.closest<HTMLTableCellElement>("td, th");
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
          offset: td.offsetTop,
        },
        col: {
          index: colIndex,
          offset: td.offsetLeft,
        },
      };
    }
  }

  const ariaCell = el.closest<HTMLElement>(
    '[role="gridcell"], [role="columnheader"]',
  );
  if (ariaCell) {
    const ariaRow = ariaCell.closest<HTMLElement>('[role="row"]');
    if (ariaRow) {
      const ariaGrid = ariaCell.closest<HTMLElement>('[role="grid"]');
      if (ariaGrid) {
        const grid = makeAriaGrid(ariaGrid);
        return {
          grid,
          row: {
            index: Number(ariaRow.ariaRowIndex),
            offset: ariaCell.offsetTop,
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
  rect.grid.root.tabIndex = -1; // make grid focusable for better keyboard accessibility
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

  // scroll if near edge of viewport,
  // kind of like https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/page/autoscroll_controller.cc
  const { root } = coords.grid;
  let gridRect = root.getBoundingClientRect();
  const margin = 50;
  const scrollMargin = 50;

  let scrollToOpts: ScrollToOptions | null = null;
  if (e.clientY < gridRect.top + margin) {
    scrollToOpts = { top: -scrollMargin, behavior: "smooth" };
  } else if (e.clientY > gridRect.bottom - margin) {
    scrollToOpts = { top: scrollMargin, behavior: "smooth" };
  }
  if (e.clientX < gridRect.left + margin) {
    scrollToOpts = { left: -scrollMargin, behavior: "smooth" };
  } else if (e.clientX > gridRect.right - margin) {
    scrollToOpts = { left: scrollMargin, behavior: "smooth" };
  }
  if (scrollInterval) {
    clearInterval(scrollInterval);
  }
  if (scrollToOpts) {
    root.scrollBy(scrollToOpts);
    scrollInterval = setInterval(() => {
      root.scrollBy(scrollToOpts);
    }, 100);
  }
});

document.addEventListener("mouseup", () => {
  dragging = false;
  if (scrollInterval) {
    clearInterval(scrollInterval);
    scrollInterval = null;
  }
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

  const frozenHeadingOffset = grid.firstDataCell()?.offsetTop ?? 0;

  let prevCell = grid.cellAt(rect.minRow.index, rect.minCol.index);
  if (prevCell === null) {
    grid.root.scrollTo({
      top: rect.minRow.offset - frozenHeadingOffset,
      behavior: "instant",
    });
    for (let attempt = 0; prevCell === null && attempt < 10; attempt++) {
      await sleep(100);
      prevCell = grid.cellAt(rect.minRow.index, rect.minCol.index);
    }
  }
  if (!prevCell) {
    console.info(
      `Could not access first cell at ${rect.minRow.index}:${rect.minCol.index} after multiple attempts.`,
    );
    return { tsv: "", html: headHtml + `<tbody></tbody>` };
  }

  for (let r = rect.minRow.index; r <= rect.maxRow.index; r++) {
    const tsvCols: string[] = [];
    const htmlCols: string[] = [];

    for (let c = rect.minCol.index; c <= rect.maxCol.index; c++) {
      let cell = grid.cellAt(r, c);
      if (!cell && prevCell) {
        grid.root.scrollTo({
          top: prevCell.offsetTop + prevCell.offsetHeight - frozenHeadingOffset,
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
      if (cell) prevCell = cell;
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
