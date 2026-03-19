/* Form validation and async-action helpers. */

export function shakeField(input: HTMLElement): void {
  input.classList.add('sync-shake');
  input.addEventListener('animationend', () => input.classList.remove('sync-shake'), { once: true });
}

export function markFieldError(
  input: HTMLInputElement | HTMLTextAreaElement,
  message: string,
): boolean {
  input.classList.add('sync-field-error');
  const existing = input.parentElement?.querySelector('.sync-field-hint');
  if (existing) existing.remove();
  const hint = document.createElement('div');
  hint.className = 'sync-field-hint';
  hint.textContent = message;
  input.insertAdjacentElement('afterend', hint);
  shakeField(input);
  input.addEventListener('input', () => clearFieldError(input), { once: true });
  return false;
}

export function clearFieldError(input: HTMLInputElement | HTMLTextAreaElement): void {
  input.classList.remove('sync-field-error');
  const hint = input.parentElement?.querySelector('.sync-field-hint');
  if (hint) hint.remove();
}

export function friendlyError(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    const msg = error.message;
    if (msg.includes('fetch') || msg.includes('network') || msg.includes('Failed to fetch')) {
      return 'Network error \u2014 check your connection and try again.';
    }
    return msg;
  }
  return fallback;
}
