// ================================================================
//  THEME
// ================================================================

const THEME_KEY = 'claude-tri-theme';

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = get('themeBtn');
  if (theme === 'sun') {
    btn.textContent = '☾';
    btn.title = 'Switch to night mode';
    btn.setAttribute('aria-label', 'Switch to night mode');
  } else {
    btn.textContent = '☀';
    btn.title = 'Switch to sunlight mode';
    btn.setAttribute('aria-label', 'Switch to sunlight mode');
  }
  refreshCards();  // update card border/dot colors for new theme
}
