export function scrollParent(element: HTMLElement | null): HTMLElement {
  let parent = element?.parentElement ?? null;
  while (parent && !/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) parent = parent.parentElement;
  return parent ?? (document.scrollingElement as HTMLElement);
}

/** Reveal an item between the sticky header and bottom player. Returns true once centered. */
export function centerInScrollArea(element: HTMLElement) {
  const owner = scrollParent(element);
  const rect = element.getBoundingClientRect();
  const heading = owner.tagName === "MAIN" ? owner.querySelector<HTMLElement>("header.sticky")?.offsetHeight ?? 0 : 0;
  const bottom = owner.tagName === "MAIN" ? parseFloat(getComputedStyle(owner).paddingBottom) || 0 : 0;
  const visible = Math.max(rect.height, owner.clientHeight - heading - bottom);
  const relativeTop = owner.getBoundingClientRect().top + owner.clientTop + heading;
  const top = Math.max(0, Math.min(owner.scrollHeight - owner.clientHeight,
    owner.scrollTop + rect.top - relativeTop - (visible - rect.height) / 2));
  if (Math.abs(owner.scrollTop - top) <= 1) return true;
  owner.scrollTop = top;
  return false;
}
