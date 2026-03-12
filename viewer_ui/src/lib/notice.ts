import { $, hide, show } from './dom';
import { state } from './state';

export function hideGlobalNotice() {
  const notice = $('globalNotice');
  if (!notice) return;
  hide(notice);
  notice.textContent = '';
  notice.classList.remove('success', 'warning');
  if (state.noticeTimer) {
    clearTimeout(state.noticeTimer);
    state.noticeTimer = null;
  }
}

export function showGlobalNotice(message: string, type: 'success' | 'warning' = 'success') {
  const notice = $('globalNotice');
  if (!notice || !message) return;
  notice.textContent = message;
  notice.classList.remove('success', 'warning');
  notice.classList.add(type === 'warning' ? 'warning' : 'success');
  show(notice);
  if (state.noticeTimer) clearTimeout(state.noticeTimer);
  state.noticeTimer = setTimeout(() => {
    hideGlobalNotice();
  }, 12_000);
}
