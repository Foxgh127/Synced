interface VirtualGridOptions<T> {
  key: (item: T) => string;
  renderItem: (item: T, index: number) => HTMLElement;
  onMount?: (element: HTMLElement, item: T, index: number) => void;
  minColumnWidth?: number;
  gap?: number;
  aspectRatio?: number;
  extraHeight?: number;
  overscanRows?: number;
  virtualizationThreshold?: number;
}

export class VirtualGrid<T> {
  private items: T[] = [];
  private frame?: number;
  private lastRange = "";
  private readonly controller = new AbortController();
  private readonly resizeObserver: ResizeObserver;

  constructor(
    private readonly grid: HTMLElement,
    private readonly scroller: HTMLElement,
    private readonly options: VirtualGridOptions<T>,
  ) {
    scroller.addEventListener("scroll", () => this.schedule(), {
      passive: true,
      signal: this.controller.signal,
    });
    this.resizeObserver = new ResizeObserver(() => this.schedule(true));
    this.resizeObserver.observe(grid);
  }

  setItems(items: readonly T[]): void {
    this.items = [...items];
    this.grid.setAttribute("aria-rowcount", String(items.length));
    this.schedule(true);
  }

  refresh(): void {
    this.schedule(true);
  }

  private schedule(force = false): void {
    if (force) this.lastRange = "";
    if (this.frame !== undefined) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined;
      this.render();
    });
  }

  private render(): void {
    if (!this.grid.isConnected || !this.scroller.isConnected) return;
    const {
      minColumnWidth = 148,
      gap = 20,
      aspectRatio = 2 / 3,
      extraHeight = 62,
      overscanRows = 2,
      virtualizationThreshold = 30,
    } = this.options;
    const width = Math.max(minColumnWidth, this.grid.clientWidth);
    const columns = Math.max(
      1,
      Math.floor((width + gap) / (minColumnWidth + gap)),
    );
    const cardWidth =
      (width - Math.max(0, columns - 1) * gap) / columns;
    const rowHeight = cardWidth / aspectRatio + extraHeight + gap;
    const totalRows = Math.ceil(this.items.length / columns);
    let startRow = 0;
    let endRow = totalRows;

    if (this.items.length > virtualizationThreshold) {
      const gridRect = this.grid.getBoundingClientRect();
      const scrollerRect = this.scroller.getBoundingClientRect();
      const gridTop =
        gridRect.top - scrollerRect.top + this.scroller.scrollTop;
      const relativeTop = Math.max(0, this.scroller.scrollTop - gridTop);
      startRow = Math.max(
        0,
        Math.floor(relativeTop / rowHeight) - overscanRows,
      );
      endRow = Math.min(
        totalRows,
        Math.ceil(
          (relativeTop + this.scroller.clientHeight) / rowHeight,
        ) + overscanRows,
      );
    }

    const startIndex = startRow * columns;
    const endIndex = Math.min(this.items.length, endRow * columns);
    const range = `${startIndex}:${endIndex}:${columns}:${Math.round(cardWidth)}`;
    if (range === this.lastRange) return;
    this.lastRange = range;

    const fragment = document.createDocumentFragment();
    if (startRow > 0) {
      fragment.append(
        this.spacer(Math.max(0, startRow * rowHeight - gap), "top"),
      );
    }
    for (let index = startIndex; index < endIndex; index += 1) {
      const item = this.items[index];
      const element = this.options.renderItem(item, index);
      element.dataset.virtualKey = this.options.key(item);
      element.setAttribute("aria-rowindex", String(index + 1));
      fragment.append(element);
      this.options.onMount?.(element, item, index);
    }
    const remainingRows = Math.max(0, totalRows - endRow);
    if (remainingRows > 0) {
      fragment.append(
        this.spacer(
          Math.max(0, remainingRows * rowHeight - gap),
          "bottom",
        ),
      );
    }
    this.grid.replaceChildren(fragment);
  }

  private spacer(height: number, edge: "top" | "bottom"): HTMLElement {
    const spacer = document.createElement("div");
    spacer.className = "emby-virtual-spacer";
    spacer.dataset.virtualSpacer = edge;
    spacer.style.height = `${height}px`;
    spacer.setAttribute("aria-hidden", "true");
    return spacer;
  }

  destroy(): void {
    this.controller.abort();
    this.resizeObserver.disconnect();
    if (this.frame !== undefined) {
      cancelAnimationFrame(this.frame);
      this.frame = undefined;
    }
    this.items = [];
    this.lastRange = "";
  }
}
