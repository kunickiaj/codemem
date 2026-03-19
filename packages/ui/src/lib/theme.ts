/* Theme management — light/dark/variant switching. */

export type ThemeOption = {
  id: string;
  label: string;
  mode: 'light' | 'dark';
};

export const THEME_OPTIONS: ThemeOption[] = [
  { id: 'light', label: 'Light', mode: 'light' },
  { id: 'dark', label: 'Dark', mode: 'dark' },
];

const THEME_STORAGE_KEY = 'codemem-theme';

function resolveTheme(themeId: string): ThemeOption {
  const exact = THEME_OPTIONS.find((t) => t.id === themeId);
  if (exact) return exact;
  const fallback = themeId.startsWith('dark') ? 'dark' : 'light';
  return THEME_OPTIONS.find((t) => t.id === fallback) || THEME_OPTIONS[0];
}

export function getTheme(): string {
  const saved = localStorage.getItem(THEME_STORAGE_KEY);
  if (saved) return resolveTheme(saved).id;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function setTheme(theme: string) {
  const selected = resolveTheme(theme);
  document.documentElement.setAttribute('data-theme', selected.mode);
  document.documentElement.setAttribute('data-color-mode', selected.mode);
  if (selected.id === selected.mode) {
    document.documentElement.removeAttribute('data-theme-variant');
  } else {
    document.documentElement.setAttribute('data-theme-variant', selected.id);
  }
  localStorage.setItem(THEME_STORAGE_KEY, selected.id);
}

export function initThemeSelect(select: HTMLSelectElement | null) {
  if (!select) return;
  select.textContent = '';
  THEME_OPTIONS.forEach((theme) => {
    const option = document.createElement('option');
    option.value = theme.id;
    option.textContent = theme.label;
    select.appendChild(option);
  });
  select.value = getTheme();
  select.addEventListener('change', () => {
    setTheme(select.value || 'dark');
  });
}
