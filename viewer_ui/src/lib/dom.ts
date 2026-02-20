/* DOM utility helpers — thin wrappers for vanilla element creation. */

export function el(tag: string, className?: string | null, text?: any): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

export function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

export function $input(id: string): HTMLInputElement | null {
  return document.getElementById(id) as HTMLInputElement | null;
}

export function $select(id: string): HTMLSelectElement | null {
  return document.getElementById(id) as HTMLSelectElement | null;
}

export function $button(id: string): HTMLButtonElement | null {
  return document.getElementById(id) as HTMLButtonElement | null;
}

export function hide(element: HTMLElement | null) {
  if (element) (element as any).hidden = true;
}

export function show(element: HTMLElement | null) {
  if (element) (element as any).hidden = false;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function highlightText(text: string, query: string): string {
  const q = query.trim();
  if (!q) return escapeHtml(text);
  const safe = escapeHtml(text);
  try {
    const re = new RegExp(`(${escapeRegExp(q)})`, 'ig');
    return safe.replace(re, '<mark class="match">$1</mark>');
  } catch {
    return safe;
  }
}

export async function copyToClipboard(text: string, button: HTMLButtonElement) {
  const prev = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied';
  } catch {
    button.textContent = 'Copy failed';
  }
  setTimeout(() => {
    button.textContent = prev || 'Copy';
  }, 1200);
}
