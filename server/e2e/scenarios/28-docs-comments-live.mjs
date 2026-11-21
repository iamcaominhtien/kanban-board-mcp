import { ensureProject, openDocs, newDocPage, setMarkdown, publishDoc } from '../lib/ui.mjs';

// Docs comments (edit, copy link, delete, resolve, reopen, attach, retry), what two people see of each other (comments,
// a conflicting publish), orphaned comments, no network (the editor's offline banners) and Docs in a window of its own.
export default {
  name: 'Docs comments: threads, orphans, two people, offline, own window',
  async run(s) {
    const a = s.page;
    let b;
    const PAGE = 'Runbook';
    const FIRST = 'Deploys ship every Tuesday morning.';
    const SECOND = 'Rollbacks restore the tagged build.';
    const THIRD = 'Pager duty rotates weekly.';
    const MD = `# ${PAGE}\n\n${FIRST}\n\n${SECOND}\n\n${THIRD}\n`;

    const panel = (q = a) => q.getByTestId('comments-panel');
    const cards = (q = a) => panel(q).getByTestId('thread-card');
    const commentsBtn = (q = a) => q.getByTestId('comments-button');
    const isOpen = async (q = a) => (await commentsBtn(q).getAttribute('aria-pressed')) === 'true';
    const openPanel = async (q = a) => { if (!(await isOpen(q))) await commentsBtn(q).click(); await panel(q).waitFor(); };
    const posted = (q, method, re) => q.waitForResponse((r) => r.request().method() === method && re.test(new URL(r.url()).pathname) && r.ok(), { timeout: 10000 });
    const openTreePage = async (q, title) => {
      await q.getByRole('tree').getByText(title, { exact: true }).first().click();
      await q.getByRole('heading', { name: title, level: 1 }).first().waitFor();
    };
    // Selects a whole paragraph of the page (triple click), the way a reader does before commenting
    const selectParagraph = async (q, text) => {
      const para = q.getByRole('paragraph').filter({ hasText: text }).first();
      await para.scrollIntoViewIfNeeded();
      await para.click({ clickCount: 3 });
      await q.getByTestId('selection-comment').waitFor();
    };
    const startComment = async (q, text) => {
      await selectParagraph(q, text);
      await q.getByTestId('selection-comment').click();
      return q.getByRole('dialog', { name: 'New comment' });
    };
    // Types at the end of the last paragraph in the rich editor of a page (real typing keeps the blocks' ids, so the
    // editor can join two people's edits of different blocks; edits of the same paragraph are a real conflict)
    const typeEnd = async (q, text, { saved = true } = {}) => {
      await q.getByTestId('docs-editor-surface').click();
      await q.keyboard.press('Control+End');
      await q.keyboard.type(' ' + text);
      await q.waitForTimeout(400);
      if (saved) await q.getByText(/^Saved/).waitFor();
    };
    // Sets the page text in the rich editor (it has no Markdown pane), as setMarkdown does for s.page
    const setMd = async (q, md) => {
      const surface = q.getByTestId('docs-editor-surface');
      await surface.waitFor();
      await surface.evaluate((el, text) => {
        el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText' }));
        el.editor.commands.setContent(text, { contentType: 'markdown', emitUpdate: true });
      }, md);
      await q.waitForTimeout(400);
      await q.getByText(/^Saved/).waitFor();
    };
    const thread = (q, text) => cards(q).filter({ hasText: text }).first();
    // Writes into the reply box of a thread (it is a one-line field until it is clicked)
    const writeReply = async (card, text) => {
      const field = card.getByTestId('reply-field');
      if (await field.count()) await field.click();
      await card.getByTestId('reply-input').fill(text);
    };
    const menuOf = async (card, index = 0) => {
      await card.getByTestId('comment-menu').nth(index).click();
      return card.getByRole('menu');
    };

    await s.step('set up: a published page with three paragraphs', async () => {
      await ensureProject(s);
      await openDocs(s);
      await newDocPage(s, PAGE);
      await setMarkdown(s, MD);
      await publishDoc(s, 'first');
      await a.getByRole('paragraph').filter({ hasText: FIRST }).first().waitFor();
    });

    await s.step('Comment on a selection opens New comment; closing it posts nothing', async () => {
      const d = await startComment(a, FIRST);
      await d.waitFor();
      await d.getByPlaceholder('Write a comment…').fill('Draft that is thrown away');
      await d.getByTestId('compose-close').click();
      await d.waitFor({ state: 'detached' });
      if (await a.getByText('Draft that is thrown away').count()) throw new Error('the closed draft was posted');
    });

    await s.step('post an inline comment: the panel opens on the new thread with its quote', async () => {
      const d = await startComment(a, FIRST);
      await d.getByPlaceholder('Write a comment…').fill('Who owns the deploy checklist?');
      await Promise.all([posted(a, 'POST', /\/comments$/), a.keyboard.press('Enter')]);
      await d.waitFor({ state: 'detached' });
      await panel().waitFor();
      const c = thread(a, 'Who owns the deploy checklist?');
      await c.waitFor();
      await c.getByTestId('thread-quote').getByText(FIRST).waitFor();
      s.note('panel header', await panel().getByRole('heading', { name: 'Inline comments' }).innerText());
    });

    await s.step('panel tabs count the threads: All, Open, Resolved', async () => {
      await panel().getByTestId('comments-tab-all').getByText(/All · 1/).waitFor();
      await panel().getByTestId('comments-tab-open').getByText(/Open · 1/).waitFor();
      await panel().getByTestId('comments-tab-resolved').getByText(/Resolved · 0/).waitFor();
      await panel().getByTestId('comments-tab-resolved').click();
      await panel().getByTestId('comments-caught-up').or(panel().getByTestId('comments-empty')).first().waitFor();
      await panel().getByTestId('comments-tab-open').click();
      await thread(a, 'Who owns the deploy checklist?').waitFor();
    });

    await s.step('Close comments hides the panel; the Comments button brings it back', async () => {
      await panel().getByRole('button', { name: 'Close comments' }).click();
      await panel().waitFor({ state: 'detached' });
      await commentsBtn().click();
      await panel().waitFor();
      await thread(a, 'Who owns the deploy checklist?').waitFor();
    });

    await s.step('edit your comment: Cancel keeps it, Save shows the new text with an edited mark', async () => {
      const c0 = thread(a, 'Who owns the deploy checklist?');
      const c = cards().and(a.locator(`[data-thread="${await c0.getAttribute('data-thread')}"]`));
      let m = await menuOf(c);
      await m.getByTestId('comment-edit').click();
      const box = c.getByTestId('comment-edit-input');
      await box.fill('This text is cancelled');
      await c.getByTestId('comment-cancel').click();
      await c.getByText('Who owns the deploy checklist?').waitFor();
      m = await menuOf(c);
      await m.getByTestId('comment-edit').click();
      await c.getByTestId('comment-edit-input').fill('Who owns the deploy checklist now?');
      await Promise.all([posted(a, 'PATCH', /\/docs\/comments\//), c.getByTestId('comment-submit').click()]);
      await c.getByText('Who owns the deploy checklist now?').waitFor();
      await c.getByTestId('comment-edited').waitFor();
    });

    await s.step('Copy link puts the thread address on the clipboard', async () => {
      const c = thread(a, 'deploy checklist now');
      const m = await menuOf(c);
      await m.getByTestId('comment-copy-link').click();
      const id = await c.getAttribute('data-thread');
      await a.waitForFunction(async (x) => (await navigator.clipboard.readText()).includes(`#comment-${x}`), id);
    });

    await s.step('reply to the thread; delete the reply: Cancel keeps it, Delete reply removes only it', async () => {
      const c = thread(a, 'deploy checklist now');
      await writeReply(c, 'Reply that will go away');
      await Promise.all([posted(a, 'POST', /\/replies$/), a.keyboard.press('Enter')]);
      await c.getByText('Reply that will go away').waitFor();
      const m = await menuOf(c, 1);
      await m.getByTestId('comment-delete').click();
      const confirm = c.getByRole('alertdialog', { name: 'Delete this comment?' });
      await confirm.getByText('Only this reply is removed.').waitFor();
      await confirm.getByRole('button', { name: 'Cancel' }).click();
      await confirm.waitFor({ state: 'detached' });
      await c.getByText('Reply that will go away').waitFor();
      const m2 = await menuOf(c, 1);
      await m2.getByTestId('comment-delete').click();
      await Promise.all([posted(a, 'DELETE', /\/docs\/comments\//), confirm.getByRole('button', { name: 'Delete reply' }).click()]);
      await c.getByText('Reply that will go away').waitFor({ state: 'detached' });
      await c.getByText('deploy checklist now').waitFor();
    });

    await s.step('page comment with an attached file: the file link lands in the text, the thread is listed', async () => {
      const pc = a.getByTestId('page-comments');
      await pc.scrollIntoViewIfNeeded();
      await pc.getByTestId('reply-field').click();
      const box = pc.getByTestId('comment-box');
      await box.getByTestId('page-comment-input').fill('Runbook note with a file:');
      const [chooser] = await Promise.all([a.waitForEvent('filechooser'), box.getByRole('button', { name: 'Attach an image or file' }).click()]);
      await chooser.setFiles({ name: 'rollback-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('rollback notes\n') });
      await a.waitForFunction(() => [...document.querySelectorAll('textarea')].some((t) => /rollback-notes\.txt/.test(t.value)), null, { timeout: 10000 });
      await Promise.all([posted(a, 'POST', /\/comments$/), box.getByTestId('comment-submit').click()]);
      await pc.getByTestId('page-comments-count').getByText('1').waitFor();
      await pc.getByText('Runbook note with a file:').waitFor();
    });

    await s.step('delete the page comment: the first comment removes the whole thread', async () => {
      const pc = a.getByTestId('page-comments');
      const c = pc.getByTestId('thread-card').first();
      const m = await menuOf(c);
      await m.getByTestId('comment-delete').click();
      const confirm = c.getByRole('alertdialog', { name: 'Delete this comment?' });
      await confirm.getByText(/This removes the thread/).waitFor();
      await Promise.all([posted(a, 'DELETE', /\/docs\/comments\//), confirm.getByRole('button', { name: 'Delete thread' }).click()]);
      await pc.getByText('Runbook note with a file:').waitFor({ state: 'detached' });
      await pc.getByTestId('page-comments-count').getByText('0').waitFor();
    });

    await s.step('resolve the thread: Open shows All caught up, Show resolved lists it as Resolved by you', async () => {
      const c = thread(a, 'deploy checklist now');
      await Promise.all([posted(a, 'POST', /\/resolve$/), c.getByRole('button', { name: 'Resolve thread' }).click()]);
      await panel().getByText('All caught up').waitFor();
      await panel().getByRole('button', { name: 'Show resolved' }).click();
      const r = thread(a, 'deploy checklist now');
      await r.getByTestId('resolved-by').waitFor();
      await r.getByTestId('resolved-by').getByText(/Resolved by You/).waitFor();
      await r.getByRole('button', { name: 'Reopen' }).waitFor();
    });

    await s.step('Reopen puts the thread back among the open ones', async () => {
      const r = thread(a, 'deploy checklist now');
      await Promise.all([posted(a, 'POST', /\/reopen$/), r.getByTestId('thread-reopen').click()]);
      await panel().getByTestId('comments-tab-open').click();
      await thread(a, 'deploy checklist now').getByRole('button', { name: 'Resolve thread' }).waitFor();
    });

    await s.step('Activity lists what happened to the comments', async () => {
      await panel().getByTestId('comments-activity-toggle').click();
      const list = panel().getByTestId('comments-activity');
      await list.waitFor();
      await list.getByRole('listitem').first().waitFor();
      s.note('activity', (await list.innerText()).split('\n').slice(0, 6));
      await panel().getByTestId('comments-activity-toggle').click();
      await list.waitFor({ state: 'detached' });
    });

    await s.step('the server refuses a reply: Not posted, the text is kept, Retry posts it once the server answers', async () => {
      const c = thread(a, 'deploy checklist now');
      const re = /\/docs\/comments\/threads\/[^/]+\/replies$/;
      const match = (u) => re.test(u.pathname);
      await a.route(match, (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"detail":"down"}' }));
      await writeReply(c, 'Reply the server refuses');
      await a.keyboard.press('Enter');
      const failed = c.getByTestId('comment-failed');
      await failed.waitFor();
      await failed.getByText('Not posted. Your text is kept.').waitFor();
      if ((await c.getByTestId('reply-input').inputValue()) !== 'Reply the server refuses') throw new Error('the text was not kept');
      await a.unroute(match);
      await Promise.all([posted(a, 'POST', /\/replies$/), failed.getByRole('button', { name: 'Retry' }).click()]);
      await c.getByText('Reply the server refuses').first().waitFor();
      await failed.waitFor({ state: 'detached' });
    }, { expectConsole: true });

    await s.step('no network: a reply waits as Posting and is posted when the network is back', async () => {
      const c = thread(a, 'deploy checklist now');
      await writeReply(c, 'Reply sent while offline');
      await a.context().setOffline(true);
      await a.keyboard.press('Enter');
      await c.getByRole('button', { name: /Posting/ }).waitFor();
      await a.context().setOffline(false);
      await c.getByText('Reply sent while offline').first().waitFor({ timeout: 15000 });
    }, { expectConsole: true });

    await s.step('the panel cannot load comments: Could not load comments, Retry brings them back', async () => {
      const re = /\/docs\/pages\/[^/]+\/comments$/;
      const match = (u) => re.test(u.pathname);
      await a.route(match, (route) => (route.request().method() === 'GET' ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"detail":"down"}' }) : route.continue()));
      await a.reload();
      await a.getByRole('button', { name: 'Docs', exact: true }).click({ timeout: 20000 });
      await a.getByRole('complementary', { name: /^Docs space/ }).waitFor();
      await openTreePage(a, PAGE);
      await commentsBtn().click();
      await panel().getByTestId('comments-error').waitFor({ timeout: 30000 });
      await panel().getByText('Could not load comments').waitFor();
      await a.unroute(match);
      await panel().getByTestId('comments-error').getByRole('button', { name: 'Retry' }).click();
      await thread(a, 'deploy checklist now').waitFor();
    }, { expectConsole: true });

    await s.step('page B opens the same page', async () => {
      b = await s.newPage();
      await b.goto(s.server.base);
      await b.getByRole('button', { name: 'Docs', exact: true }).click({ timeout: 20000 });
      await b.getByRole('complementary', { name: /^Docs space/ }).waitFor();
      await openTreePage(b, PAGE);
      await openPanel(b);
      await thread(b, 'deploy checklist now').waitFor();
    });

    await s.step('a comment made in A shows in B without a reload, and B\'s reply shows in A', async () => {
      const d = await startComment(a, SECOND);
      await d.getByPlaceholder('Write a comment…').fill('Is the rollback tested?');
      await Promise.all([posted(a, 'POST', /\/comments$/), a.keyboard.press('Enter')]);
      await thread(b, 'Is the rollback tested?').waitFor({ timeout: 10000 });
      const cb = thread(b, 'Is the rollback tested?');
      await writeReply(cb, 'Yes, last Friday.');
      await Promise.all([posted(b, 'POST', /\/replies$/), b.keyboard.press('Enter')]);
      await thread(a, 'Is the rollback tested?').getByText('Yes, last Friday.').waitFor({ timeout: 10000 });
    });

    await s.step('resolving in B marks the thread resolved in A', async () => {
      await Promise.all([posted(b, 'POST', /\/resolve$/), thread(b, 'Is the rollback tested?').getByRole('button', { name: 'Resolve thread' }).click()]);
      await a.getByTestId('comments-tab-resolved').getByText(/Resolved · 1/).waitFor({ timeout: 10000 });
      await a.getByTestId('comments-tab-open').getByText(/Open · 1/).waitFor();
    });

    await s.step('Edit opens the rich editor: the page is edited in place, there is no Markdown source pane', async () => {
      await a.getByRole('button', { name: 'Edit', exact: true }).click();
      await a.getByRole('textbox', { name: 'Page title' }).waitFor();
      await a.getByTestId('docs-editor-surface').waitFor();
      await a.getByRole('textbox', { name: 'Markdown source' }).waitFor({ state: 'detached' });
    });

    // Publishes from the editor through the Publish page dialog (no orphan warning on the way)
    const publishNow = async (note) => {
      await a.getByTestId('publish').click();
      const d = a.getByRole('dialog', { name: 'Publish page' });
      await d.getByRole('textbox', { name: 'Version note' }).fill(note);
      await d.getByRole('button', { name: /^Publish v\d+/ }).click();
      await d.waitFor({ state: 'detached' });
      await a.getByRole('button', { name: 'Edit', exact: true }).waitFor();
    };

    await s.step('rewriting the commented paragraph publishes without a warning; the thread follows the new text', async () => {
      await setMd(a, `# ${PAGE}\n\nFresh opening line.\n\n${SECOND}\n\n${THIRD}\n`);
      await publishNow('rewrote the first paragraph');
      await openPanel();
      const c = thread(a, 'deploy checklist now');
      await c.getByTestId('thread-quote').getByText('Fresh opening line.').waitFor();
      if (await c.getByTestId('orphan-notice').count()) throw new Error('a rewritten paragraph orphaned its thread');
      if ((await c.getAttribute('data-state')) !== 'open') throw new Error(`state ${await c.getAttribute('data-state')}`);
    });

    await s.step('the thread keeps one quiet line of what happened: Text rewritten, and the words it was on', async () => {
      const line = thread(a, 'deploy checklist now').getByTestId('anchor-line');
      await line.waitFor();
      const text = await line.innerText();
      if (!/Text rewritten in v\d+/.test(text) || !text.includes(`was “${FIRST}”`)) throw new Error(`anchor line: ${text}`);
      s.note('anchor line', text);
    });

    await s.step('removing the commented text and publishing warns about the orphaned comment', async () => {
      await a.getByRole('button', { name: /^(Edit|Continue editing)$/ }).click();
      await a.getByRole('textbox', { name: 'Page title' }).waitFor();
      await setMd(a, `# ${PAGE}\n\n${SECOND}\n\n${THIRD}\n`);
      await a.getByTestId('publish').click();
      const w = a.getByRole('alertdialog', { name: 'Publish with orphaned comments' });
      await w.waitFor();
      await w.getByText(/Publish with 1 orphaned comment\?/).waitFor();
      await w.getByText('“Fresh opening line.”').waitFor();
    });

    await s.step('Review comments closes the warning and opens the comments panel', async () => {
      const w = a.getByRole('alertdialog', { name: 'Publish with orphaned comments' });
      await w.getByRole('button', { name: 'Review comments' }).click();
      await w.waitFor({ state: 'detached' });
      await panel().waitFor();
    });

    await s.step('Publish anyway goes on to the publish dialog and publishes', async () => {
      await a.getByTestId('publish').click();
      const w = a.getByRole('alertdialog', { name: 'Publish with orphaned comments' });
      await w.getByRole('button', { name: 'Publish anyway' }).click();
      const d = a.getByRole('dialog', { name: 'Publish page' });
      await d.getByRole('textbox', { name: 'Version note' }).fill('removed the first paragraph');
      await d.getByRole('button', { name: /^Publish v\d+/ }).click();
      await d.waitFor({ state: 'detached' });
      await a.getByRole('button', { name: 'Edit', exact: true }).waitFor();
    });

    await s.step('the thread now says its text was removed, with a Text removed line', async () => {
      await openPanel();
      const c = thread(a, 'deploy checklist now');
      await c.getByText('Text removed', { exact: true }).waitFor();
      await c.getByTestId('orphan-notice').waitFor();
      await c.locator('[data-testid="anchor-line"][data-change="removed"]').waitFor();
    });

    await s.step('Show where it was scrolls to the spot the text stood and marks it for a moment', async () => {
      const c = thread(a, 'deploy checklist now');
      const spot = a.locator('[data-block-id]').filter({ hasText: SECOND }).first();
      await c.getByTestId('thread-show-where').click();
      await spot.and(a.locator('.dc-where-flash')).waitFor();
      await a.locator('.dc-where-flash').waitFor({ state: 'detached' });
    });

    await s.step('Re-attach to selection waits for a selection; Cancel stops waiting', async () => {
      const c = thread(a, 'deploy checklist now');
      await c.getByTestId('thread-reattach').click();
      await c.getByTestId('reattach-hint').waitFor();
      await c.getByTestId('reattach-hint').getByRole('button', { name: 'Cancel' }).click();
      await c.getByTestId('reattach-hint').waitFor({ state: 'detached' });
    });

    await s.step('Re-attach: selecting new text and Attach here moves the thread onto it', async () => {
      const c = thread(a, 'deploy checklist now');
      await c.getByTestId('thread-reattach').click();
      await selectParagraph(a, SECOND);
      await Promise.all([posted(a, 'POST', /\/reattach$/), a.getByTestId('selection-comment').click()]);
      await c.getByTestId('thread-quote').getByText(SECOND).waitFor();
      await c.getByTestId('orphan-notice').waitFor({ state: 'detached' });
    });

    // Page B edits the page in its own editor and publishes (what the other person does in the conflict steps)
    const publishFromB = async (markdown) => {
      await b.getByRole('button', { name: /^(Edit|Continue editing)$/ }).click();
      await b.getByRole('textbox', { name: 'Page title' }).waitFor();
      await typeEnd(b, markdown);
      await b.getByTestId('publish').click();
      const d = b.getByRole('dialog', { name: 'Publish page' });
      await d.getByRole('button', { name: /^Publish v\d+/ }).click();
      await d.waitFor({ state: 'detached' });
      await b.getByRole('button', { name: 'Edit', exact: true }).waitFor();
    };
    const editInA = async (markdown) => {
      await a.getByRole('button', { name: /^(Edit|Continue editing)$/ }).click();
      await a.getByRole('textbox', { name: 'Page title' }).waitFor();
      await typeEnd(a, markdown);
    };
    // both people type into the same last paragraph, the one thing the rich editor cannot join by itself
    const body = (extra) => extra;
    const banner = () => a.getByTestId('conflict-banner');

    await s.step('A edits the page while B publishes a newer version: A\'s Publish ends in the conflict banner', async () => {
      await editInA(body('Edit made in A.'));
      await publishFromB(body('Edit made in B.'));
      await a.getByTestId('publish').click();
      const d = a.getByRole('dialog', { name: 'Publish page' });
      await d.getByRole('button', { name: /^Publish v\d+/ }).click();
      await banner().waitFor();
      await banner().getByText('Someone else edited this page').waitFor();
      await banner().getByText(/published v\d+/).waitFor();
      if (!(await a.getByTestId('publish').isDisabled())) throw new Error('Publish stays enabled in a conflict');
    }, { expectConsole: true });

    await s.step('View their changes shows what B changed; Hide changes closes it', async () => {
      await banner().getByRole('button', { name: 'View their changes' }).click();
      await banner().getByText(/Showing what changed in v\d+/).waitFor();
      await banner().getByText(/Edit made in B\./).waitFor();
      await banner().getByRole('button', { name: 'Hide changes' }).click();
      await banner().getByText(/Showing what changed/).waitFor({ state: 'detached' });
    });

    await s.step('Keep mine publishes A\'s text over B\'s version and leaves the editor', async () => {
      await banner().getByRole('button', { name: 'Keep mine' }).click();
      // the editor asks once before it overwrites the other version
      await Promise.all([posted(a, 'POST', /\/publish$/), a.getByTestId('keep-mine-yes').click()]);
      await banner().waitFor({ state: 'detached' });
      await a.getByRole('button', { name: 'Edit', exact: true }).waitFor();
      await a.getByText('Edit made in A.').waitFor();
      await a.getByText('Edit made in B.').waitFor({ state: 'detached' });
    });

    await s.step('a second conflict: Reload drops A\'s edit and shows B\'s version', async () => {
      await editInA(body('Second edit in A.'));
      await b.getByText('Edit made in A.').first().waitFor({ timeout: 10000 });
      await publishFromB(body('Second edit in B.'));
      await a.getByTestId('publish').click();
      await a.getByRole('dialog', { name: 'Publish page' }).getByRole('button', { name: /^Publish v\d+/ }).click();
      await banner().waitFor();
      await Promise.all([a.waitForResponse((r) => r.request().method() === 'DELETE' && /\/draft$/.test(new URL(r.url()).pathname)), banner().getByRole('button', { name: 'Reload' }).click()]);
      await a.getByRole('button', { name: 'Edit', exact: true }).waitFor();
      await a.getByText('Second edit in B.').waitFor();
      await a.getByText('Second edit in A.').waitFor({ state: 'detached' });
    }, { expectConsole: true });

    await s.step('editor offline: the banner appears and Publish is disabled', async () => {
      await editInA(body('Edit before going offline.'));
      await a.context().setOffline(true);
      const off = a.getByTestId('offline-banner');
      await off.waitFor();
      await off.getByText('You are offline').waitFor();
      if (!(await a.getByTestId('publish').isDisabled())) throw new Error('Publish stays enabled offline');
    }, { expectConsole: true });

    await s.step('Retry now with a pending edit waits; the edit is saved and Back online shows when the network returns', async () => {
      await typeEnd(a, body('Edit typed offline.'), { saved: false }); // offline: nothing can be saved yet
      await a.getByTestId('offline-banner').getByRole('button', { name: 'Retry now' }).click();
      await a.context().setOffline(false);
      const on = a.getByTestId('online-banner');
      await on.waitFor({ timeout: 15000 });
      await on.getByText('Back online').waitFor();
      await a.getByText(/^Saved/).waitFor();
      await a.getByTestId('offline-banner').waitFor({ state: 'detached' });
      await on.getByRole('button', { name: 'Dismiss' }).click();
      await on.waitFor({ state: 'detached' });
    }, { expectConsole: true });

    await s.step('Retry now with nothing to save: the banner stays while the network is off, Back online when it returns', async () => {
      await a.getByTestId('online-banner').waitFor({ state: 'detached' });
      await a.context().setOffline(true);
      const off = a.getByTestId('offline-banner');
      await off.waitFor();
      // with nothing to save, "Retry now" asks the server (it used to hide the banner without asking, still offline)
      // Chromium's offline mode still lets requests to the local server through, so the server is made unreachable
      // for the health check by hand
      await a.route('**/health', (r) => r.abort('internetdisconnected'));
      await off.getByRole('button', { name: 'Retry now' }).click();
      // the check runs ("Checking…"), fails, and the banner stays (it used to go without asking anything)
      await off.getByRole('button', { name: 'Checking…' }).waitFor({ state: 'detached' });
      await off.getByRole('button', { name: 'Retry now' }).waitFor();
      await a.unroute('**/health');
      await a.context().setOffline(false);
      await off.waitFor({ state: 'detached' });
      await a.getByTestId('online-banner').waitFor();
      await a.getByTestId('online-banner').getByRole('button', { name: 'Dismiss' }).click();
    }, { expectConsole: true });

    await s.step('Discard leaves the editor; the page shows the last published text', async () => {
      await a.getByTestId('discard').click();
      const d = a.getByRole('dialog').filter({ hasText: /Discard/ }).first();
      await d.getByRole('button', { name: /^Discard/ }).last().click();
      await a.getByRole('button', { name: /^(Edit|Continue editing)$/ }).waitFor();
      await a.getByText('Edit typed offline.').waitFor({ state: 'detached' });
    });

    await s.step('Open Docs in its own window: the board says Docs is in another window', async () => {
      const [popup] = await Promise.all([a.waitForEvent('popup'), a.getByRole('button', { name: 'Open Docs in its own window' }).click()]);
      s.popup = popup;
      await popup.getByTestId('docs-window').waitFor({ timeout: 15000 });
      await popup.getByRole('heading', { name: PAGE, level: 1 }).first().waitFor();
      await a.getByTestId('docs-popped-out').waitFor();
      await a.getByText('Docs is open in its own window').waitFor();
    });

    await s.step('the window shows the page with its comments; Show the window brings it forward', async () => {
      const w = s.popup;
      await w.getByRole('heading', { name: PAGE, level: 1 }).first().waitFor();
      await openPanel(w);
      await thread(w, 'deploy checklist now').waitFor();
      await a.getByTestId('docs-show-window').click();
      await w.getByTestId('docs-window').waitFor();
    });

    await s.step('Dock back here closes the window and Docs returns to the board on the same page', async () => {
      const w = s.popup;
      await Promise.all([w.waitForEvent('close'), a.getByTestId('docs-dock-here').click()]);
      await a.getByTestId('docs-popped-out').waitFor({ state: 'detached' });
      await a.getByRole('heading', { name: PAGE, level: 1 }).first().waitFor();
    });

    await s.step('two identical paragraphs: the thread is drawn on the copy it was made on, not the first one', async () => {
      const call = async (method, url, body) => {
        const r = await fetch(`${s.server.base}${url}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
        if (!r.ok) throw new Error(`${method} ${url}: ${r.status} ${await r.text()}`);
        return r.json();
      };
      const projects = await call('GET', '/projects');
      const pid = (Array.isArray(projects) ? projects : projects.projects)[0].id;
      const pg = await call('POST', `/projects/${pid}/docs/pages`, { title: 'Twins' });
      const para = (id, text) => ({ type: 'paragraph', attrs: { blockId: id }, content: [{ type: 'text', text }] });
      const SAME = 'Check it on a real machine first.';
      await call('PUT', `/docs/pages/${pg.id}/draft`, { content: { type: 'doc', content: [para('b-000001', SAME), para('b-000002', 'Between.'), para('b-000003', SAME)] } });
      await call('POST', `/docs/pages/${pg.id}/publish`, { base_version: 0 });
      const t = await call('POST', `/docs/pages/${pg.id}/comments`, { kind: 'inline', body: 'The second one', anchor: { quote: SAME, block_id: 'b-000003' } });
      await openTreePage(a, 'Twins');
      const badge = a.locator(`[data-testid="comment-badge"][data-thread="${t.id}"]`);
      await badge.waitFor();
      const block = await badge.evaluate((el) => el.closest('[data-block-id]')?.getAttribute('data-block-id'));
      if (block !== 'b-000003') throw new Error(`the thread is drawn on ${block}, it was made on b-000003`);
    });
  },
};
