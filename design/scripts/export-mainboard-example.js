// Reference example (not a general tool): exports the 4 visual blocks of MainBoard.dc.html as 2x PNGs.
// Structure used: root = `x-dc > div`; each top-level child = [caption, visual block, optional text]; clip = bounding box of the block (+ small padding).
// Run: NODE_PATH=$(npm root -g) node export-mainboard-example.js  (paths below are the author sandbox; adjust file:// and output dir).
const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox','--ignore-certificate-errors'] });
  const p = await b.newPage({ viewport: { width: 1880, height: 3800 }, deviceScaleFactor: 2 });
  await p.goto('file:///tmp/claude-0/-home-user-kanban-board-mcp/ad45f27c-4971-5471-89d7-f81fdedde14f/scratchpad/artifact-files/515d3226-7f5b-4747-a45e-f53b5709add5/project/MainBoard.dc.html', { waitUntil: 'networkidle' });
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(800);
  const data = await p.evaluate(() => {
    const root = document.querySelector('x-dc > div');
    const kids = [...root.children];
    const tight = (el) => {
      const all = [el, ...el.querySelectorAll('*')];
      let x1=1e9,y1=1e9,x2=0,y2=0;
      for (const n of all) { if (n === el) continue; const r = n.getBoundingClientRect(); if (!r.width||!r.height) continue; x1=Math.min(x1,r.left);y1=Math.min(y1,r.top);x2=Math.max(x2,r.right);y2=Math.max(y2,r.bottom); }
      return {x:x1-6,y:y1-3,width:x2-x1+12,height:y2-y1+6};
    };
    const sub = (i,j) => kids[i].children[j];
    const clipFull = (e)=>{const r=e.getBoundingClientRect();return {x:r.x-12,y:r.y-12,width:r.width+24,height:r.height+24};};
    return {
      clips: {
        '1-full-screen': clipFull(sub(1,1)),
        '2-filter-dropdowns': tight(sub(2,1)),
        '3-column-states': tight(sub(3,1)),
        '4-banners-toasts': tight(sub(4,1)),
      },
      text: {
        title: kids[0].children[1].innerText,
        intro: kids[0].children[2].innerText,
        cap1: kids[1].children[0].innerText,
        cap2: kids[2].children[0].innerText,
        desc2: kids[2].children[2].innerText,
        cap3: kids[3].children[0].innerText,
        cap4: kids[4].children[0].innerText,
        note: kids[5].innerText,
      }
    };
  });
  for (const [name, clip] of Object.entries(data.clips)) {
    await p.screenshot({ path: '/tmp/claude-0/-home-user-kanban-board-mcp/ad45f27c-4971-5471-89d7-f81fdedde14f/scratchpad/doc-trial/main-board/images/main-board-' + name + '.png', clip });
  }
  fs.writeFileSync('/tmp/claude-0/-home-user-kanban-board-mcp/ad45f27c-4971-5471-89d7-f81fdedde14f/scratchpad/doc-trial/main-board/texts.json', JSON.stringify(data, null, 2));
  await b.close();
})();
