import { useRef, type KeyboardEvent } from "react";

export interface TabDescriptor {
  id: string;
  label: string;
}

interface TabListProps {
  "aria-label": string;
  tabs: readonly TabDescriptor[];
  selected: string;
  onSelect(id: string): void;
}

/**
 * Accessible tab group: tablist semantics, roving tabindex, and
 * ArrowLeft/ArrowRight/Home/End keyboard navigation per the APG tabs pattern.
 */
export function TabList({ tabs, selected, onSelect, ...rest }: TabListProps) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  function focus(id: string): void {
    buttons.current.get(id)?.focus();
  }

  function move(current: string, direction: 1 | -1): void {
    const index = tabs.findIndex((tab) => tab.id === current);
    const next = tabs[(index + direction + tabs.length) % tabs.length];
    if (next) {
      onSelect(next.id);
      focus(next.id);
    }
  }

  function onKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    id: string,
  ): void {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      move(id, 1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      move(id, -1);
    } else if (event.key === "Home") {
      event.preventDefault();
      const first = tabs[0];
      if (first) {
        onSelect(first.id);
        focus(first.id);
      }
    } else if (event.key === "End") {
      event.preventDefault();
      const last = tabs[tabs.length - 1];
      if (last) {
        onSelect(last.id);
        focus(last.id);
      }
    }
  }

  return (
    <div role="tablist" {...rest}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          ref={(element) => {
            if (element) buttons.current.set(tab.id, element);
            else buttons.current.delete(tab.id);
          }}
          type="button"
          role="tab"
          aria-selected={tab.id === selected}
          tabIndex={tab.id === selected ? 0 : -1}
          onClick={() => onSelect(tab.id)}
          onKeyDown={(event) => onKeyDown(event, tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
