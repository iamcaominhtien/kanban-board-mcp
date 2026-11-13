// A text snapshot of what a person sees: visible text, with form values, per region.
export async function snapshot(page, norm) {
  const raw = await page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
    };
    const lines = (el) => (el.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
    const fields = (root) => {
      const out = [];
      for (const el of root.querySelectorAll('input, textarea, select')) {
        if (!vis(el) || el.type === 'file' || el.type === 'hidden') continue;
        const name = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.id || el.type;
        if (el.type === 'checkbox' || el.type === 'radio') out.push(`[${el.type} ${name}: ${el.checked ? 'on' : 'off'}]`);
        else if (el.tagName === 'SELECT') out.push(`[select ${name}: ${el.options[el.selectedIndex]?.text ?? ''}]`);
        else out.push(`[field ${name}: ${(el.value || '').slice(0, 300)}]`);
      }
      return out;
    };
    const regions = {};
    const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open]')].filter(vis);
    dialogs.forEach((d, i) => { regions[`dialog${i ? i + 1 : ''}`] = [...lines(d), ...fields(d)]; });
    const main = document.querySelector('main') || document.body;
    regions.main = [...lines(main), ...fields(main)];
    const toasts = [...document.querySelectorAll('[role="status"], [role="alert"]')].filter(vis).map((e) => e.innerText.trim()).filter(Boolean);
    if (toasts.length) regions.alerts = toasts;
    regions.url = [location.pathname + location.search + location.hash];
    return regions;
  });
  const out = {};
  for (const [k, v] of Object.entries(raw)) out[k] = v.map((l) => norm.text(l));
  return out;
}
