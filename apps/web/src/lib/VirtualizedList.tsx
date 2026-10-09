import { useCallback, useRef, useState, type ReactNode } from "react";

interface VirtualizedListProps<T> {
  items: readonly T[];
  renderItem(item: T, index: number): ReactNode;
  itemHeight: number;
  containerHeight: number;
  overscan?: number;
  "aria-label"?: string;
  keyOf?: (item: T, index: number) => string;
}

/**
 * Windowed list: renders only the visible slice (plus overscan) inside a
 * fixed-height scroll container, so thousand-row note/artifact lists stay
 * out of the DOM. Items remain native focusable elements for keyboard users.
 */
export function VirtualizedList<T>({
  items,
  renderItem,
  itemHeight,
  containerHeight,
  overscan = 3,
  keyOf,
  ...rest
}: VirtualizedListProps<T>) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);

  const onScroll = useCallback(() => {
    setScrollTop(scroller.current?.scrollTop ?? 0);
  }, []);

  const totalHeight = items.length * itemHeight;
  const start = Math.max(
    0,
    Math.floor(scrollTop / itemHeight) - overscan,
  );
  const visibleCount = Math.ceil(containerHeight / itemHeight) + overscan * 2;
  const end = Math.min(items.length, start + visibleCount);
  const topPadding = start * itemHeight;
  const bottomPadding = totalHeight - topPadding - (end - start) * itemHeight;

  return (
    <div
      ref={scroller}
      data-testid="virtual-scroller"
      role="region"
      tabIndex={0}
      onScroll={onScroll}
      style={{ overflowY: "auto", height: containerHeight }}
      {...rest}
    >
      <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
        {topPadding > 0 ? (
          <li aria-hidden="true" style={{ height: topPadding }} />
        ) : null}
        {items.slice(start, end).map((item, offset) => {
          const index = start + offset;
          return (
            <li
              key={keyOf ? keyOf(item, index) : index}
              style={{ minHeight: itemHeight }}
            >
              {renderItem(item, index)}
            </li>
          );
        })}
        {bottomPadding > 0 ? (
          <li aria-hidden="true" style={{ height: bottomPadding }} />
        ) : null}
      </ul>
    </div>
  );
}
