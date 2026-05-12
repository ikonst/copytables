const className = "copy-tables-selected";
const leftClassName = "copy-tables-left-selected";
const rightClassName = "copy-tables-right-selected";
const topClassName = "copy-tables-top-selected";
const bottomClassName = "copy-tables-bottom-selected";
const gridSelector = 'table, [role="grid"], [role="table"]';
const rowSelector = 'tr, [role="row"]';
const cellSelector =
  'td, th, [role="cell"], [role="gridcell"], [role="columnheader"]';

interface Grid {
  root: HTMLElement;
  rowIterator(): Generator<{ element: HTMLElement; index: number }>;
  colIterator(
    row: HTMLElement,
  ): Generator<{ element: HTMLElement; index: number }>;
  cellAt(r: number, c: number): HTMLElement | null;
  rowElement(r: number): HTMLElement | null;
  isHeaderRow(row: HTMLElement): boolean;
  firstDataCell(): HTMLElement | null;
}

interface Coords {
  row: IndexWithOffset;
  col: IndexWithOffset;
}

interface IndexWithOffset {
  index: number; // index (1-based, like the ARIA indexes) of the row/column
  offset: number; // offset in pixels from the top/left of the grid, used for scrolling into view
}

interface SelectionRect {
  grid: Grid;
  minRow: IndexWithOffset;
  maxRow: IndexWithOffset;
  minCol: IndexWithOffset;
  maxCol: IndexWithOffset;
}

let selection: {
  grid: Grid;
  anchor: Coords;
  focus: Coords;
} | null = null;
let dragging = false;
let observer: MutationObserver | null = null;
let scrollInterval: number | null = null;

function makeTableGrid(table: HTMLTableElement): Grid | null {
  if (selection?.grid.root === table) {
    return selection.grid;
  }

  // Chromium has nice heuristic for detecting "layout tables":
  // https://source.chromium.org/chromium/chromium/src/+/main:third_party/blink/renderer/modules/accessibility/ax_node_object.cc;l=1951-2191?q=return%20Role::kLayoutTable&ss=chromium%2Fchromium%2Fsrc
  // There's no API for getting a computed ARIA role yet, so we'll do some of its rules here:
  // - must have a heading
  // - must have more than 10 rows
  if (!(table.querySelector("th") || table.tHead || table.rows.length >= 10)) {
    return null;
  }

  function* rowIterator(): Generator<{ element: HTMLElement; index: number }> {
    const rows = table.rows;
    let i = 0;
    for (const row of rows) {
      i++;
      yield { element: row, index: i };
    }
  }

  function* colIterator(
    row: HTMLElement,
  ): Generator<{ element: HTMLElement; index: number }> {
    const cells = (row as HTMLTableRowElement).cells;
    let i = 0;
    for (const cell of cells) {
      i++;
      yield { element: cell, index: i };
    }
  }

  return {
    root: table,
    rowIterator,
    colIterator,
    cellAt(r: number, c: number): HTMLElement | null {
      const row = table.rows[r - 1];
      if (row) {
        const cell = row.cells[c - 1];
        if (cell) {
          return cell;
        }
      }
      return null;
    },
    rowElement(r: number): HTMLElement | null {
      return table.rows[r - 1] || null;
    },
    isHeaderRow(row: HTMLElement): boolean {
      if (!(row instanceof HTMLTableRowElement)) {
        return false;
      }
      if (row.closest("thead")) return true;
      const { cells } = row;
      if (cells.length === 0) return false;
      for (const cell of cells) {
        if (cell.tagName === "TH") {
          return true;
        }
      }
      return false;
    },
    firstDataCell(): HTMLElement | null {
      for (const row of table.rows) {
        for (const cell of row.cells) {
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
  if (selection?.grid.root === gridEl) {
    return selection.grid;
  }

  function* rowIterator(): Generator<{
    element: HTMLElement;
    index: number;
  }> {
    let rowIndex = 0;
    for (const row of gridEl.querySelectorAll<HTMLElement>(rowSelector)) {
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
      yield { element: row, index: rowIndex };
    }
  }

  function* colIterator(row: HTMLElement): Generator<{
    element: HTMLElement;
    index: number;
  }> {
    let colIndex = 0;
    for (const cell of row.querySelectorAll<HTMLElement>(cellSelector)) {
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
      yield { element: cell, index: colIndex };
    }
  }

  function rowElement(r: number): HTMLElement | null {
    for (const { element: row, index: ri } of rowIterator()) {
      if (ri === r) {
        return row;
      }
    }
    return null;
  }

  return {
    root: gridEl,
    rowIterator,
    colIterator,
    cellAt(r: number, c: number): HTMLElement | null {
      for (const { element: row, index: rowIndex } of rowIterator()) {
        for (const { element: cell, index: colIndex } of colIterator(row)) {
          if (rowIndex === r && colIndex === c) {
            return cell;
          }
        }
      }
      return null;
    },
    rowElement,
    isHeaderRow(row: HTMLElement): boolean {
      if (!row) return false;
      const cells = Array.from(row.querySelectorAll(cellSelector));
      if (cells.length === 0) return false;
      return cells.every((c) => c.role === "columnheader");
    },
    firstDataCell(): HTMLElement | null {
      for (const { element: row } of rowIterator()) {
        for (const { element: cell } of colIterator(row)) {
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
    return makeTableGrid(table);
  }

  const ariaGrid = el.closest<HTMLElement>(gridSelector);
  if (ariaGrid) return makeAriaGrid(ariaGrid);
  return null;
}

function getCellProps(el: Element): { grid: Grid; coords: Coords } | null {
  const td = el.closest<HTMLTableCellElement>("td, th");
  if (td) {
    const table = td.closest("table");
    if (table) {
      const grid = makeTableGrid(table);
      if (!grid) return null;
      const tr = td.closest("tr");
      if (!tr) return null;
      const allRows = Array.from(table.rows);
      const rowIndex = allRows.indexOf(tr);
      const colIndex = Array.from(tr.cells).indexOf(td);
      if (rowIndex === -1 || colIndex === -1) return null;
      return {
        grid,
        coords: {
          row: {
            index: rowIndex + 1,
            offset: td.offsetTop,
          },
          col: {
            index: colIndex + 1,
            offset: td.offsetLeft,
          },
        },
      };
    }
  }

  const ariaCell = el.closest<HTMLElement>(cellSelector);
  if (ariaCell) {
    const ariaRow = ariaCell.closest<HTMLElement>(rowSelector);
    if (ariaRow) {
      const ariaGrid = ariaCell.closest<HTMLElement>(gridSelector);
      if (ariaGrid) {
        const grid = makeAriaGrid(ariaGrid);
        let rowIndex = Number(ariaRow.ariaRowIndex);
        if (!rowIndex) {
          for (const { element, index } of grid.rowIterator()) {
            if (element === ariaRow) {
              rowIndex = index;
              break;
            }
          }
        }
        let colIndex = Number(ariaCell.ariaColIndex);
        if (!colIndex) {
          for (const { element, index } of grid.colIterator(ariaRow)) {
            if (element === ariaCell) {
              colIndex = index;
              break;
            }
          }
        }

        return {
          grid,
          coords: {
            row: {
              index: rowIndex,
              offset: ariaCell.offsetTop,
            },
            col: {
              index: colIndex,
              offset: ariaCell.offsetLeft,
            },
          },
        };
      }
    }
  }
  return null;
}

function removeSelectionClasses(): void {
  document.querySelectorAll(`.${className}`).forEach((el) => {
    el.classList.remove(className);
    el.classList.remove(leftClassName);
    el.classList.remove(rightClassName);
    el.classList.remove(topClassName);
    el.classList.remove(bottomClassName);
  });
}

function getRect(): SelectionRect | null {
  if (!selection) return null;
  const { grid, anchor, focus } = selection;
  if (!focus) return null;

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
    grid: grid,
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
  if (!selection) return;
  observer = new MutationObserver(() => {
    highlightSelection();
  });
  observer.observe(selection.grid.root, {
    childList: true,
    subtree: true,
  });
}

function clearSelection(): void {
  if (!selection) return;
  removeSelectionClasses();
  disconnectObserver();
  selection = null;
}

function highlightSelection(): void {
  disconnectObserver();
  removeSelectionClasses();
  const rect = getRect();
  if (!rect) return;
  for (const { element: row, index: r } of rect.grid.rowIterator()) {
    for (const { element: cell, index: c } of rect.grid.colIterator(row)) {
      if (
        r >= rect.minRow.index &&
        r <= rect.maxRow.index &&
        c >= rect.minCol.index &&
        c <= rect.maxCol.index
      ) {
        cell.classList.add(className);
        if (r === rect.minRow.index) {
          cell.classList.add(topClassName);
        }
        if (r === rect.maxRow.index) {
          cell.classList.add(bottomClassName);
        }
        if (c === rect.minCol.index) {
          cell.classList.add(leftClassName);
        }
        if (c === rect.maxCol.index) {
          cell.classList.add(rightClassName);
        }
      }
    }
  }

  rect.grid.root.tabIndex = -1; // make grid focusable for better keyboard accessibility
  observeGrid();
}

function checkIsMac() {
  return (
    /Mac|iPhone|iPad|iPod/.test(navigator.platform) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

document.addEventListener("mousedown", (e: MouseEvent) => {
  if (!(e.target instanceof Element)) return;
  if (e.buttons !== 1) return; // only respond to main button

  // On Mac, only shift
  // On other platforms, only ctrl
  const isMac = checkIsMac();
  if (!(e.shiftKey == isMac && e.ctrlKey == !isMac && e.altKey == false)) {
    clearSelection();
    return;
  }

  const cellProps = getCellProps(e.target);
  if (!cellProps) {
    clearSelection();
    return;
  }

  e.preventDefault();
  if (!selection || selection.grid !== cellProps.grid) {
    selection = {
      grid: cellProps.grid,
      anchor: cellProps.coords,
      focus: cellProps.coords,
    };
  } else {
    selection.focus = cellProps.coords;
  }
  highlightSelection();
  dragging = true;
});

document.addEventListener("mousemove", (e: MouseEvent) => {
  if (!dragging || e.buttons !== 1 || !selection) return;
  if (!(e.target instanceof Element)) return;
  const cellProps = getCellProps(e.target);
  if (!cellProps || cellProps.grid.root !== selection.grid.root) return;
  const { coords } = cellProps;
  if (
    coords.row !== selection.focus.row ||
    coords.col !== selection.focus.col
  ) {
    e.preventDefault();
    selection.focus = coords;
    highlightSelection();
  }

  startScrollingIfNearEdge(e, cellProps.grid.root);
});

// scroll if near edge of viewport,
// kind of like https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/page/autoscroll_controller.cc
function startScrollingIfNearEdge(e: MouseEvent, viewport: HTMLElement): void {
  let gridRect = viewport.getBoundingClientRect();
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
  stopScrolling();
  if (scrollToOpts) {
    viewport.scrollBy(scrollToOpts);
    scrollInterval = setInterval(() => {
      viewport.scrollBy(scrollToOpts);
    }, 100);
  }
}

function stopScrolling(): void {
  if (scrollInterval) {
    clearInterval(scrollInterval);
    scrollInterval = null;
  }
}

document.addEventListener("mouseup", () => {
  dragging = false;
  stopScrolling();
});

function cellTsvText(cell: HTMLElement | null): string {
  if (!cell) return "";
  let s = cell.innerText.trim().replaceAll("\t", " ").replaceAll("\r", "");
  if (s.match(/[\n"]/)) {
    s = `"${s.replaceAll('"', '""')}"`;
  }
  return s;
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

  const headRowsHtml: string[] = [];
  for (const { element, index: r } of grid.rowIterator()) {
    if (!grid.isHeaderRow(element)) break;
    if (r >= rect.minRow.index) break;
    const tsvCols: string[] = [];
    const htmlCols: string[] = [];
    for (let c = rect.minCol.index; c <= rect.maxCol.index; c++) {
      const cell = grid.cellAt(r, c);
      tsvCols.push(cellTsvText(cell));
      htmlCols.push(cellHTML(cell));
    }
    tsvLines.push(tsvCols.join("\t"));
    headRowsHtml.push(`<tr>${htmlCols.join("")}</tr>`);
  }

  let html = "<table>";
  if (headRowsHtml.length > 0) {
    html += `<thead>${headRowsHtml.join("")}</thead>`;
  }

  // Consider everything above the first *data* cell to be "frozen" like Excel's frozen panes.
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
    return { tsv: "", html: html + `<tbody></tbody>` };
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
      tsvCols.push(cellTsvText(cell));
      htmlCols.push(cellHTML(cell));
      if (cell) prevCell = cell;
    }
    tsvLines.push(tsvCols.join("\t"));
    htmlLines.push(`<tr>${htmlCols.join("")}</tr>`);
  }

  const tsv = tsvLines.join("\n");
  html += `<tbody>${htmlLines.join("")}</tbody></table>`;
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
