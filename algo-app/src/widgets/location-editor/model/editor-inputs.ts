/** Raw text errors must block persistence even when the last valid document is unchanged. */
export function invalidEditorInput(root: HTMLElement | null): HTMLElement | null {
  return root?.querySelector<HTMLElement>('[data-local-invalid="true"]') ?? null;
}

/** Reveal errors inside collapsed sections before moving keyboard focus to the input. */
export function focusEditorInput(input: HTMLElement): void {
  for (let parent = input.parentElement; parent; parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement) parent.open = true;
  }
  input.focus({ preventScroll: true });
  const reveal = () => {
    if (input.isConnected) (input.closest('label') ?? input).scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };
  reveal();
  // Error banners and opened disclosures change the bounded inspector height after render.
  requestAnimationFrame(() => requestAnimationFrame(reveal));
}
