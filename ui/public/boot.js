// Runs before first paint (classic script, no inline code so it also passes the Electron CSP).
// Decides whether the splash intro should play: once per cold start, skipped on warm reloads.
(function () {
  var mode = 'cold';
  try {
    if (window.sessionStorage.getItem('kb-splash-seen')) mode = 'warm';
  } catch (e) {
    /* storage blocked: treat as cold start */
  }
  document.documentElement.setAttribute('data-splash', mode);
})();
