// Print page helper. Kept as a file so the page works under the site's content security policy.
document.getElementById('print-now')?.addEventListener('click', () => window.print());
if (new URLSearchParams(window.location.search).get('autoprint') === '1') {
  window.addEventListener('load', () => setTimeout(() => window.print(), 300));
}
