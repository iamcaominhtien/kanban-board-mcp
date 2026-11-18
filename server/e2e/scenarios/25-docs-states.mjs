import fs from 'node:fs';
import { ensureProject, openDocs, newDocPage, publishDoc, setMarkdown } from '../lib/ui.mjs';

// The states of the new Docs (design RichDocsStates 1-4): the save status and its states, editing offline (a queue in
// the browser, sent when back online), someone publishing meanwhile (joined by block, or chosen block by block), a
// save that keeps failing (Not saved, Keep a copy), a viewer's read-only page with its role chip, the skip link, and
// the bar of an older version. Each state is measured against the board's numbers.
export default {
  name: 'Docs states: save status, offline queue, merge and conflict by block, save failed, viewer, skip link',
  async run(s) {
    const p = s.page;
    const base = s.server.base;
    const content = () => p.getByRole('textbox', { name: 'Page content' });
    const state = () => p.getByTestId('save-state');
    const measured = {};
    const api = async (method, path, data, actor) => {
      const r = await p.request.fetch(`${base}${path}`, {
        method,
        data,
        headers: actor ? { 'X-Actor': actor } : undefined,
      });
      if (!r.ok()) throw new Error(`${method} ${path} answered ${r.status()} ${await r.text()}`);
      return r.json();
    };
    const css = (loc, props) =>
      loc.evaluate((el, ps) => {
        const cs = getComputedStyle(el);
        const b = el.getBoundingClientRect();
        return Object.fromEntries([...ps.map((k) => [k, cs.getPropertyValue(k)]), ['width', b.width], ['height', b.height]]);
      }, props);
    // Hoa Mai publishes the page with one paragraph changed (by its text), on the version given
    const publishAs = async (who, version, from, to) => {
      const pg = await api('GET', `/docs/pages/${ids.page}`);
      const doc = JSON.parse(JSON.stringify(pg.content));
      const blk = doc.content.find((b) => (b.content ?? []).some((t) => t.text === from));
      if (!blk) throw new Error(`no paragraph "${from}" in the published page`);
      blk.content = [{ type: 'text', text: to }];
      return api('POST', `/docs/pages/${ids.page}/publish`, { base_version: version, content: doc, title: pg.title, note: `${who} edit` }, who);
    };
    const typeAtEnd = async (text, words) => {
      await content().getByText(text, { exact: true }).click();
      await p.keyboard.press('End');
      await p.keyboard.type(words);
    };
    const ids = {};

    await s.step('set up: a project with Hoa Mai and a viewer, a page of three paragraphs published as v1', async () => {
      await ensureProject(s);
      const projects = await api('GET', '/projects');
      ids.project = projects.find((x) => x.name === 'Alpha').id;
      await api('POST', `/projects/${ids.project}/members`, { name: 'Hoa Mai', role: 'member' });
      await api('POST', `/projects/${ids.project}/members`, { name: 'Vy Tran', role: 'viewer' });
      await openDocs(s);
      await newDocPage(s, 'States tour');
      await setMarkdown(s, 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n');
      await publishDoc(s, 'Three paragraphs');
      await p.getByText('Published · v1').waitFor();
      const tree = await api('GET', `/projects/${ids.project}/docs/tree`);
      const walk = (ns) => ns.flatMap((n) => [n, ...walk(n.children ?? [])]);
      ids.page = walk(tree).find((n) => n.title === 'States tour').id;
    });

    await s.step('save status: Saving… while the edit is on its way, then Saved with the time (board C 13)', async () => {
      await p.getByRole('button', { name: 'Edit', exact: true }).click();
      await content().waitFor();
      await state().and(p.locator('[data-state="saved"]')).waitFor();
      await typeAtEnd('Second paragraph.', ' Typed now.');
      await state().and(p.locator('[data-state="saving"]')).waitFor();
      await state().and(p.locator('[data-state="saved"]')).waitFor({ timeout: 15000 });
      const text = await state().textContent();
      if (!/^Saved\d\d:\d\d$/.test(text)) throw new Error('the saved status reads ' + text);
      measured.saved = await css(state(), ['font-size', 'font-weight', 'color', 'gap']);
      if (measured.saved['font-size'] !== '12.5px' || measured.saved['font-weight'] !== '600' || measured.saved.color !== 'rgb(46, 111, 64)')
        throw new Error('Saved is not 12.5px / 600 / #2E6F40: ' + JSON.stringify(measured.saved));
      s.note('saved', measured.saved);
    });

    await s.step('offline: the grey bar, "Offline · N changes waiting", the list of what waits, Publish off (D 21, 24)', async () => {
      await s.context.setOffline(true);
      const bar = p.getByTestId('offline-banner');
      await bar.getByText('You are offline').waitFor();
      await typeAtEnd('First paragraph.', ' Mine.');
      await state().and(p.locator('[data-state="offline"]')).getByText(/[1-9]\d* changes? waiting/).waitFor();
      if (!(await p.getByTestId('publish').isDisabled())) throw new Error('Publish must wait for the connection');
      measured.offlineBar = await css(bar, ['padding', 'gap', 'background-color', 'border-bottom-color']);
      if (measured.offlineBar.padding !== '11px 16px' || measured.offlineBar['background-color'] !== 'rgb(241, 243, 241)')
        throw new Error('the offline bar is not the board grey bar: ' + JSON.stringify(measured.offlineBar));
      await state().click();
      const list = p.getByTestId('waiting-list');
      await list.getByText('Kept in this browser. They are sent in order when the connection returns.').waitFor();
      await s.shot('waiting');
      await list.getByText('Needs a connection. Your draft is safe.').waitFor();
      measured.waitingList = await css(list, ['padding', 'border-radius', 'box-shadow']);
      await p.keyboard.press('Escape');
      await list.waitFor({ state: 'detached' });
      // the draft waits in this browser
      await p.waitForFunction((id) => !!localStorage.getItem(`docsOfflineDraft:${id}`), ids.page);
      s.note('offline', { bar: measured.offlineBar, list: measured.waitingList });
    }, { expectConsole: true });

    await s.step('back online, nobody else changed the page: "Draft synced", then Saved (D 25)', async () => {
      await s.context.setOffline(false);
      await p.getByTestId('online-banner').getByText('Draft synced. No one else changed this page while you were away.').waitFor({ timeout: 20000 });
      await state().and(p.locator('[data-state="saved"]')).waitFor({ timeout: 15000 });
      measured.syncedBar = await css(p.getByTestId('online-banner'), ['background-color', 'padding']);
      s.note('synced', measured.syncedBar);
    });

    await s.step('offline again while Hoa Mai publishes another block: joined by itself on return, Merged for you (D 23-26)', async () => {
      await s.context.setOffline(true);
      await p.getByTestId('offline-banner').waitFor();
      await typeAtEnd('Second paragraph. Typed now.', ' And more.');
      await state().and(p.locator('[data-state="offline"]')).getByText(/[1-9]\d* changes? waiting/).waitFor();
      await publishAs('Hoa Mai', 1, 'Third paragraph.', 'Third paragraph, by Hoa.');
      await s.context.setOffline(false);
      const bar = p.getByTestId('online-banner');
      await bar.getByText(/Hoa Mai changed 1 block while you were away/).waitFor({ timeout: 20000 });
      measured.joinedBar = await css(bar, ['background-color', 'border-bottom-color']);
      await content().getByText('Third paragraph, by Hoa.').waitFor();
      await content().getByText('First paragraph. Mine.').waitFor();
      await bar.getByRole('button', { name: 'Review' }).click();
      const d = p.getByTestId('merged-dialog');
      await d.getByText('Hoa Mai changed the paragraph').waitFor();
      await d.getByText('3 blocks · v1 → v2').waitFor();
      measured.mergedDialog = await css(d, ['border-radius', 'box-shadow']);
      await s.shot('merged');
      if (measured.mergedDialog.width !== 520 || measured.mergedDialog['border-radius'] !== '16px')
        throw new Error('Merged for you is not 520 wide, r16: ' + JSON.stringify(measured.mergedDialog));
      await d.getByRole('button', { name: 'Done' }).click();
      await d.waitFor({ state: 'detached' });
      await state().and(p.locator('[data-state="saved"]')).waitFor({ timeout: 15000 });
      s.note('joined', { bar: measured.joinedBar, dialog: measured.mergedDialog });
    }, { expectConsole: true });

    await s.step('Hoa Mai changes the same block, Publish: paused, chosen block by block, then published (E 30-34)', async () => {
      await publishAs('Hoa Mai', 2, 'First paragraph.', 'First paragraph. Hoa ending.');
      await p.getByRole('button', { name: 'Publish', exact: true }).click();
      const pd = p.getByRole('dialog', { name: 'Publish page' });
      await pd.getByRole('button', { name: /^Publish v\d+/ }).click();
      const banner = p.getByTestId('conflict-banner');
      await banner.getByText(/1 block needs your choice/).waitFor({ timeout: 15000 });
      await state().and(p.locator('[data-state="paused"]')).getByText('Paused').waitFor();
      if (!(await p.getByTestId('publish').isDisabled())) throw new Error('Publish must be paused');
      await banner.getByRole('button', { name: 'Choose, block by block' }).click();
      const ch = p.getByTestId('conflict-chooser');
      await ch.getByText('One block changed in both versions').waitFor();
      await ch.getByTestId('conflict-mine').locator('ins', { hasText: 'Mine.' }).waitFor();
      await ch.getByTestId('conflict-theirs').locator('ins', { hasText: 'Hoa' }).waitFor();
      measured.chooser = await css(ch, ['border-radius', 'box-shadow']);
      measured.side = await css(ch.getByTestId('conflict-mine'), ['border-top-width', 'border-top-color', 'border-radius']);
      if (measured.chooser.width !== 1000 || measured.chooser['border-radius'] !== '16px')
        throw new Error('the chooser is not 1000 wide, r16: ' + JSON.stringify(measured.chooser));
      await s.shot('chooser');
      await ch.getByTestId('conflict-choice-theirs').click();
      await ch.getByText('1 of 1 chosen').waitFor();
      await ch.getByRole('button', { name: 'Apply and continue' }).click();
      await ch.waitFor({ state: 'detached' });
      const toast = p.getByTestId('joined-toast');
      await toast.getByText('Joined. Publish is available again.').waitFor();
      await toast.getByText('Your page is now based on v3.').waitFor();
      measured.toast = await css(toast, ['border-radius', 'padding', 'gap']);
      await content().getByText('First paragraph. Hoa ending.').waitFor();
      await p.getByTestId('publish').and(p.locator(':enabled')).waitFor();
      await state().and(p.locator('[data-state="saved"]')).waitFor({ timeout: 15000 });
      await publishDoc(s, 'After the choice');
      await p.getByText('Published · v4').waitFor();
      await p.getByText('First paragraph. Hoa ending.').waitFor();
      await p.getByText('Third paragraph, by Hoa.').waitFor();
      s.note('conflict', { chooser: measured.chooser, side: measured.side, toast: measured.toast });
    }, { expectConsole: true });

    await s.step('a save that keeps failing: Not saved with Retry, the red bar, Keep a copy, then Retry now saves (C 13-18)', async () => {
      await p.getByRole('button', { name: 'Edit', exact: true }).click();
      await content().waitFor();
      await state().and(p.locator('[data-state="saved"]')).waitFor();
      await p.route(/\/docs\/pages\/[^/]+\/draft$/, (route) =>
        route.request().method() === 'PUT'
          ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: { code: 'db_busy', message: 'Database busy' } }) })
          : route.continue(),
      );
      await typeAtEnd('Second paragraph. Typed now. And more.', ' Failing.');
      const bar = p.getByTestId('save-failed-bar');
      await bar.getByText("Couldn't save your changes").waitFor({ timeout: 40000 });
      await state().and(p.locator('[data-state="error"]')).getByText('Not saved').waitFor();
      measured.failedBar = await css(bar, ['background-color', 'border-bottom-color', 'padding']);
      if (measured.failedBar['background-color'] !== 'rgb(253, 241, 238)') throw new Error('the failed bar is not red: ' + JSON.stringify(measured.failedBar));
      await bar.getByRole('button', { name: 'Keep a copy' }).click();
      const d = p.getByTestId('keep-copy-dialog');
      await d.getByText('Keep a copy of this page').waitFor();
      measured.keepCopy = await css(d, ['border-radius']);
      await s.shot('keep-copy');
      if (measured.keepCopy.width !== 520) throw new Error('Keep a copy is not 520 wide: ' + measured.keepCopy.width);
      const [dl] = await Promise.all([p.waitForEvent('download'), d.getByTestId('keep-go').click()]);
      if (dl.suggestedFilename() !== 'States tour.html') throw new Error('the copy is named ' + dl.suggestedFilename());
      await d.waitFor({ state: 'detached' });
      await p.unroute(/\/docs\/pages\/[^/]+\/draft$/);
      await bar.getByRole('button', { name: 'Retry now' }).click();
      await state().and(p.locator('[data-state="saved"]')).waitFor({ timeout: 15000 });
      await bar.waitFor({ state: 'detached' });
      s.note('failed', { bar: measured.failedBar, keepCopy: measured.keepCopy });
    }, { expectConsole: true });

    await s.step('session ended: a dialog over the page, the changes kept, saved again when the window is back (F 38)', async () => {
      await p.route(/\/docs\/pages\/[^/]+\/draft$/, (route) =>
        route.request().method() === 'PUT'
          ? route.fulfill({
              status: 403,
              contentType: 'application/json',
              body: JSON.stringify({ detail: "This request must come from the board's own window. An AI run changes the board through the kanban MCP tools, not the REST API or a browser." }),
            })
          : route.continue(),
      );
      await typeAtEnd('Third paragraph, by Hoa.', ' Signed out.');
      const d = p.getByTestId('session-ended');
      await d.getByText('Your session ended').waitFor({ timeout: 15000 });
      await d.getByText(/Nothing was lost: [1-9]\d* changes? (is|are) kept in this browser/).waitFor();
      await d.getByText('Signing in opens a new tab, so this page stays as it is.').waitFor();
      measured.session = await css(d, ['border-radius', 'box-shadow']);
      measured.sessionIcon = await css(d.locator('.dst-session-icon'), ['background-color', 'color']);
      measured.sessionTitle = await css(d.getByText('Your session ended'), ['font-size', 'font-weight']);
      await s.shot('session-ended');
      if (measured.session.width !== 520 || measured.session['border-radius'] !== '16px' || measured.sessionIcon.width !== 52)
        throw new Error('the session dialog is not the board 520 / r16 / 52 px icon: ' + JSON.stringify(measured));
      await state().and(p.locator('[data-state="error"]')).waitFor();
      await p.keyboard.press('Escape');
      await d.waitFor({ state: 'detached' });
      await p.getByTestId('session-ended-bar').getByRole('button', { name: 'Sign in again' }).waitFor();
      await p.waitForFunction((id) => !!localStorage.getItem(`docsOfflineDraft:${id}`), ids.page);
      await p.unroute(/\/docs\/pages\/[^/]+\/draft$/);
      // signing in happened in another tab: coming back to this window saves what was kept
      await p.evaluate(() => window.dispatchEvent(new Event('focus')));
      await state().and(p.locator('[data-state="saved"]')).waitFor({ timeout: 15000 });
      await p.getByTestId('session-ended-bar').waitFor({ state: 'detached' });
      s.note('session', { dialog: measured.session, icon: measured.sessionIcon, title: measured.sessionTitle });
    }, { expectConsole: true });

    await s.step('readability check: a hard-to-read colour and a picture without a description, Fix (J 74)', async () => {
      await publishDoc(s, 'Before the readability check');
      const pg = await api('GET', `/docs/pages/${ids.page}`);
      const doc = JSON.parse(JSON.stringify(pg.content));
      // a real picture (a missing one would only add a 404), stored without a description
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
      const up = await p.request.post(`${base}/uploads/images`, { multipart: { file: { name: 'dot.png', mimeType: 'image/png', buffer: png } } });
      if (!up.ok()) throw new Error('the picture was not uploaded: ' + up.status());
      doc.content.push(
        { type: 'paragraph', content: [{ type: 'text', text: 'Pale words.', marks: [{ type: 'textStyle', attrs: { color: '#e8b93a' } }] }] },
        { type: 'image', attrs: { src: (await up.json()).url, alt: '' } },
      );
      await api('PUT', `/docs/pages/${ids.page}/draft`, { content: doc, title: pg.title, base_version: pg.version });
      // open the page again so it reads the draft
      await p.goto(base);
      await p.getByRole('button', { name: /^Alpha ALP/ }).click();
      await openDocs(s);
      await p.getByRole('tree').getByRole('treeitem', { name: /States tour/ }).first().click();
      await p.getByTestId('edit-page').click();
      await content().waitFor();
      await content().getByText('Pale words.').waitFor();
      const btn = p.getByTestId('readability-button');
      await btn.getByText('2 to look at').waitFor({ timeout: 15000 });
      await btn.click();
      const list = p.getByTestId('readability-check');
      await list.getByText('Checked while you write. Nothing here blocks Publish.').waitFor();
      await list.getByText(/custom colour 1 on White, 1\.\d to 1/).waitFor();
      await list.getByText(/a picture\. People who cannot see it will not know what it shows\./).waitFor();
      measured.readList = await css(list, ['padding', 'border-radius']);
      measured.readTag = await css(list.getByText('2 to look at'), ['height', 'background-color', 'color', 'font-size']);
      await s.shot('readability');
      if (measured.readList.width !== 420 || measured.readList.padding !== '14px 16px' || measured.readTag.height !== 22)
        throw new Error('the readability list is not the board 420 / 14 16 / 22 px tag: ' + JSON.stringify(measured));
      if (!(await p.getByTestId('publish').isEnabled())) throw new Error('the check must not block Publish');
      await list.getByRole('button', { name: /^Fix/ }).click();
      await btn.getByText('1 to look at').waitFor();
      await p.keyboard.press('Escape');
      await list.waitFor({ state: 'detached' });
      await state().and(p.locator('[data-state="saved"]')).waitFor({ timeout: 15000 });
      s.note('readability', { list: measured.readList, tag: measured.readTag });
    });

    await s.step('the older version bar: purple, its buttons 26 px under the line (History board 4)', async () => {
      await publishDoc(s);
      await p.getByTestId('status-badge').click();
      await p.getByRole('dialog', { name: /^Version \d+$/ }).getByRole('button', { name: /Page history/ }).click();
      await p.getByTestId('version-row-2').hover();
      await p.getByTestId('version-menu-2').click();
      await p.getByTestId('menu-open').click();
      const bar = p.getByTestId('older-version-bar');
      await bar.getByText('You are reading v2.').waitFor();
      measured.olderBar = await css(bar, ['background-color', 'border-top-color', 'border-radius', 'padding']);
      measured.olderBack = await css(p.getByTestId('older-back'), ['height', 'border-radius', 'font-size']);
      if (measured.olderBar['background-color'] !== 'rgb(241, 236, 251)' || measured.olderBack.height !== 26)
        throw new Error('the older bar is not the board purple bar: ' + JSON.stringify(measured));
      await p.getByTestId('older-back').click();
      await bar.waitFor({ state: 'detached' });
      s.note('older', { bar: measured.olderBar, back: measured.olderBack });
    });

    await s.step('the skip link shows on focus and moves to the page text (J 69)', async () => {
      const link = p.getByTestId('skip-link');
      await link.focus();
      measured.skip = await css(link, ['transform', 'background-color', 'font-size']);
      if (measured.skip.transform !== 'none') throw new Error('the skip link does not show on focus');
      await p.keyboard.press('Enter');
      await p.waitForFunction(() => document.activeElement?.id === 'dk-page-main');
      await p.getByRole('main', { name: 'The page' }).waitFor();
      s.note('skip', measured.skip);
    });

    await s.step('phone: the offline bar is a slim overlay above the page, the status short (D 22)', async () => {
      const size = p.viewportSize();
      await p.setViewportSize({ width: 390, height: 844 });
      await p.getByRole('button', { name: /^(Edit|Continue)$/ }).first().click();
      await content().waitFor();
      await s.context.setOffline(true);
      const bar = p.getByTestId('offline-banner');
      await bar.getByText('Edits are kept here and sync when you are back.').waitFor();
      measured.phoneBar = await css(bar, ['padding', 'background-color']);
      measured.phoneOverlay = await css(bar.locator('xpath=..'), ['position', 'box-shadow']);
      measured.phoneStatus = await state().textContent();
      if (measured.phoneBar.padding !== '10px 14px' || measured.phoneOverlay.position !== 'absolute' || measured.phoneStatus !== 'Offline')
        throw new Error('the phone offline bar is not the board overlay: ' + JSON.stringify(measured));
      await s.context.setOffline(false);
      await bar.waitFor({ state: 'detached' });
      await p.setViewportSize(size);
      s.note('phone', { bar: measured.phoneBar, overlay: measured.phoneOverlay, status: measured.phoneStatus });
    });

    await s.step('a viewer: Edit is off, the role chip says Viewer, and the reason is one tap away (H 57)', async () => {
      await p.evaluate(() => localStorage.setItem('kanbanActor', 'Vy Tran'));
      await p.goto(base);
      await p.getByRole('button', { name: /^Alpha ALP/ }).click();
      await openDocs(s);
      await p.getByRole('tree').getByRole('treeitem', { name: /States tour/ }).first().click();
      const chip = p.getByTestId('role-chip');
      await chip.getByText('Viewer').waitFor();
      if (!(await p.getByTestId('edit-page').isDisabled())) throw new Error('a viewer must not edit');
      measured.roleChip = await css(chip, ['height', 'background-color', 'color', 'font-size', 'font-weight']);
      await chip.click();
      const note = p.getByTestId('role-note');
      await note.getByText('You can read and comment').waitFor();
      await note.getByText(/Your role in Alpha is/).waitFor();
      await note.getByRole('button', { name: 'Ask for edit access' }).click();
      await note.getByText(/Request sent|You already asked/).waitFor();
      await p.evaluate(() => localStorage.removeItem('kanbanActor'));
      s.note('viewer', measured.roleChip);
    });

    await s.step('phone: a page that is not there says so, its buttons full width and 44 px high (F 48)', async () => {
      const pid = (await api('GET', '/projects')).find((x) => x.name === 'Alpha').id;
      const ctx = await s.browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'en-US', timezoneId: 'UTC' });
      ctx.setDefaultTimeout(8000);
      const t = await ctx.newPage();
      try {
        await t.goto(`${base}/?proj=${pid}&docs=00000000-0000-0000-0000-000000000000`);
        const st = t.getByTestId('docs-not-found');
        await st.getByText('Page not found').waitFor({ timeout: 20000 });
        const col = await st.locator('.dst-state').evaluate((el) => Math.round(el.getBoundingClientRect().width));
        const btns = await st.locator('.dst-state-btns .st-btn').evaluateAll((els) => els.map((e) => [Math.round(e.getBoundingClientRect().width), Math.round(e.getBoundingClientRect().height)]));
        if (!btns.length || btns.some(([w, h]) => w !== col || h < 44)) throw new Error(`buttons ${JSON.stringify(btns)} in a ${col} px column`);
        measured.phoneNotFound = { col, btns };
        s.note('phone not found', measured.phoneNotFound);
      } finally {
        await ctx.close();
      }
    });

    if (process.env.E2E_STATES_MEASURE) fs.writeFileSync(process.env.E2E_STATES_MEASURE, JSON.stringify(measured, null, 2));
  },
};
