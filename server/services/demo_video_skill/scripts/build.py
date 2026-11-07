"""Builds a demo video from a scenario file: the app runs in a frame, a stage around it adds the caption band, camera,
spotlight, hand cursor, intro and outro; Playwright drives the app and the browser's screencast gives 1080p frames;
the voice, clicks, typing, whoosh and music are made by code and mixed; ffmpeg muxes it all into an MP4.

  python3 build.py scenarios/kanban-tour.json --url http://127.0.0.1:PORT/ --out /tmp/demo-out
"""
import argparse, asyncio, base64, json, os, re, subprocess, sys, time
from pathlib import Path
import common
common.ensure_deps()
import numpy as np
from playwright.async_api import async_playwright
import audio

W, H, BAND = 1280, 720, 80
VH = H - BAND

HOST = (Path(__file__).parent / "stage.html").read_text()

SCROLL_JS = """([to, ms]) => new Promise(res => {
  let best=null; document.querySelectorAll('*').forEach(e=>{const s=getComputedStyle(e); if((s.overflowY==='auto'||s.overflowY==='scroll') && e.scrollHeight>e.clientHeight+50 && e.clientHeight>200){ if(!best||e.scrollHeight>best.scrollHeight) best=e; }});
  if(!best) return res(0);
  const from=best.scrollTop, max=best.scrollHeight-best.clientHeight, target=Math.min(to,max), t0=performance.now();
  const step=(t)=>{ const k=Math.min((t-t0)/ms,1), e=k<.5?2*k*k:1-Math.pow(-2*k+2,2)/2; best.scrollTop=from+(target-from)*e; k<1?requestAnimationFrame(step):res(max); };
  requestAnimationFrame(step); })"""

async def main(a):
    sc = json.loads(Path(a.scenario).read_text())
    out_dir = Path(a.out).resolve(); work = out_dir / "work"; work.mkdir(parents=True, exist_ok=True)
    os.chdir(work)
    ff = common.ffmpeg_exe()
    intro, outro = sc["intro"], sc["outro"]
    host = (HOST.replace("__W__", str(W)).replace("__VH__", str(VH)).replace("__BAND__", str(BAND)).replace("__BASE__", a.url)
            .replace("__TITLE__", intro["title"]).replace("__SUBTITLE__", intro.get("subtitle", ""))
            .replace("__CHIPS__", "".join(f'<span class="chip">{c}</span>' for c in intro.get("chips", [])))
            .replace("__OUTRO_TITLE__", outro.get("title", intro["title"])).replace("__OUTRO_TAGLINE__", outro.get("tagline", "")))
    scenes = [dict(kind="intro", say=intro["say"], cap=intro.get("caption", "")), *sc["scenes"], dict(kind="outro", say=outro["say"], cap=outro.get("caption", ""))]
    nar = [audio.tts(s["say"], f"n_{i}", voice=sc.get("voice", "vi-VN-HoaiMyNeural"), tempo=sc.get("tempo", 1.08)) for i, s in enumerate(scenes)]
    dur = [len(x) / audio.SR for x in nar]
    print("narration seconds", [round(d, 1) for d in dur], "sum", round(sum(dur), 1), flush=True)
    voice_ev, sfx_ev, frames = [], [], []
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=common.chromium_exe())
        ctx = await b.new_context(viewport={"width": W, "height": H}, device_scale_factor=1.5)
        pg = await ctx.new_page()
        cdp = await ctx.new_cdp_session(pg)
        def on_frame(e):
            frames.append((e["metadata"]["timestamp"], base64.b64decode(e["data"])))
            asyncio.ensure_future(cdp.send("Page.screencastFrameAck", {"sessionId": e["sessionId"]}))
        cdp.on("Page.screencastFrame", on_frame)
        T0 = time.monotonic(); WALL0 = time.time()
        await cdp.send("Page.startScreencast", {"format": "jpeg", "quality": 94, "maxWidth": 1920, "maxHeight": 1080, "everyNthFrame": 1})
        now = lambda: time.monotonic() - T0
        await pg.set_content(host)
        fl = pg.frame_locator("#app")
        app = lambda: next(f for f in pg.frames if f != pg.main_frame)
        js = lambda code: pg.evaluate(code)

        def loc(spec):
            kind, _, val = spec.partition(":")
            if kind == "testid": return fl.get_by_test_id(val).first
            if kind == "text": return fl.get_by_text(val).first
            if kind == "exact": return fl.get_by_text(val, exact=True).first
            if kind == "re": return fl.get_by_text(re.compile(val, re.I)).first
            if kind == "css": return fl.locator(val).first
            raise SystemExit(f"unknown target {spec!r}: use testid:, text:, exact:, re: or css:")
        async def rect(spec): return await loc(spec).evaluate("e=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height]}")
        async def vis(spec):
            """Scroll the target into view (at once, and only when it is not fully visible) before the step acts on it."""
            moved = await loc(spec).evaluate("e=>{const r=e.getBoundingClientRect(); if(r.top>=0&&r.bottom<=innerHeight) return false; e.scrollIntoView({block: r.height>innerHeight*0.8?'start':'center', behavior:'instant'}); return true}")
            if moved: await pg.wait_for_timeout(400)
        async def stage(x, y): return await pg.evaluate("([x,y])=>__toStage(x,y)", [x, y])
        async def until(t):
            d = t - now()
            if d > 0: await pg.wait_for_timeout(int(d * 1000))
        async def cam_to(r, s, ms=1100):
            if r is None: await js(f"__cam({W/2},{VH/2},1,{ms})")
            else: await js(f"__cam({r[0]+r[2]/2},{r[1]+r[3]/2},{s},{ms})")
            await pg.wait_for_timeout(ms + 100)
        async def move(r, click=False, spec=None):
            sx, sy = await stage(r[0] + r[2] / 2, r[1] + r[3] / 2)
            await js(f"__cursor({sx - 13},{sy - 3})"); await pg.wait_for_timeout(850)
            await pg.mouse.move(sx, sy)
            if click:
                sfx_ev.append(("click", now())); await js(f"__ripple({sx},{sy})")
                if spec: await loc(spec).click(timeout=8000)   # lands on the element even if the page moved while the hand travelled
                else: await pg.mouse.down(); await pg.wait_for_timeout(90); await pg.mouse.up()

        async def run_step(st, t_scene, d_scene):
            do = st["do"]
            if do == "cam":
                if st.get("target"): await vis(st["target"])
                r = await rect(st["target"]) if st.get("target") else None
                await cam_to(r, st.get("scale", 1.4), st.get("ms", 1100))
            elif do == "spot":
                if not st.get("target"): await js("__spot()"); return
                await vis(st["target"]); r = await rect(st["target"]); g = st.get("grow", {})
                r = [r[0] - g.get("left", 0), r[1] - g.get("top", 0), r[2] + g.get("left", 0) + g.get("right", 0), r[3] + g.get("top", 0) + g.get("bottom", 0)]
                await js(f"__spot({r[0]},{r[1]},{r[2]},{r[3]},{st.get('pad', 10)})")
            elif do in ("hover", "click"):
                await vis(st["target"]); await move(await rect(st["target"]), click=(do == "click"), spec=st["target"])
                if do == "click": await pg.wait_for_timeout(int(st.get("settle", 1.0) * 1000))
            elif do == "type":
                if st.get("target"): await move(await rect(st["target"]), click=True); await pg.wait_for_timeout(600)
                t = now(); await pg.keyboard.type(st["text"], delay=st.get("delay", 60))
                sfx_ev.append(("typing", t, now() - t)); await pg.wait_for_timeout(500)
            elif do == "scroll":
                await app().evaluate(SCROLL_JS, [st["to"], st.get("ms", 1200)]); await pg.wait_for_timeout(st.get("ms", 1200) + 100)
            elif do == "key": await pg.keyboard.press(st["key"])
            elif do == "wait": await pg.wait_for_timeout(int(st["seconds"] * 1000))
            elif do == "until": await until(t_scene + 0.25 + d_scene * st["frac"])
            else: raise SystemExit(f"unknown step {do!r}")

        # ---- intro: the banner shows while the app loads under it
        starts = {}
        starts[0] = now(); voice_ev.append((0, starts[0] + 0.25)); sfx_ev.append(("chime", 0.3))
        await js(f"__prog({1/len(scenes)},100)")
        await loc(sc["ready"]).wait_for(timeout=30000)
        await until(0.25 + dur[0] + 0.8)
        sfx_ev.append(("whoosh", now())); await js("__bannerOut(900)"); await pg.wait_for_timeout(900)
        # ---- the scenes
        for i, s in enumerate(scenes):
            if i == 0: continue
            starts[i] = now(); voice_ev.append((i, starts[i] + 0.25))
            await js(f"__cap({s['cap']!r})"); await js(f"__prog({(i+1)/len(scenes)},{int((dur[i]+0.8)*1000)})")
            if s["kind"] == "outro":
                await js("__cam(%s,%s,1,900)" % (W / 2, VH / 2)); await js("__spot()")
                for st in outro.get("steps", []): await run_step(st, starts[i], dur[i])
                await until(starts[i] + 0.25 + dur[i] * 0.55)
                sfx_ev.append(("whoosh", now())); sfx_ev.append(("chime", now() + 0.35)); await js("__outro(800)")
                await until(starts[i] + 0.25 + dur[i] + 1.6)
                break
            for st in s.get("steps", []): await run_step(st, starts[i], dur[i])
            await until(starts[i] + 0.25 + dur[i] + 0.2)
        end = now()
        await cdp.send("Page.stopScreencast"); await ctx.close(); await b.close()

    # ---- frames to 30 fps (each frame lasts until the next arrives), 1080p, limited range
    os.makedirs("frames", exist_ok=True); lines = []; frames.sort(key=lambda f: f[0])
    for i, (ts, data) in enumerate(frames):
        path = f"frames/{i:05d}.jpg"; Path(path).write_bytes(data)
        t_i = max(ts - WALL0, 0.0); t_next = (frames[i + 1][0] - WALL0) if i + 1 < len(frames) else end
        lines.append(f"file '{os.path.abspath(path)}'\nduration {max(t_next - (t_i if i else 0.0), 0.001):.4f}")
    lines.append(f"file '{os.path.abspath(f'frames/{len(frames)-1:05d}.jpg')}'")
    Path("frames.txt").write_text("\n".join(lines))
    subprocess.run([ff, "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", "frames.txt", "-vf",
                    "fps=30,scale=1920:1080:flags=lanczos:out_range=tv:out_color_matrix=bt709,format=yuv420p", "-c:v", "libx264", "-crf", "14",
                    "-preset", "slow", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "silent.mp4"], check=True)
    # ---- the sound
    sfx_arr = {"click": audio.click(), "whoosh": audio.whoosh(), "chime": audio.chime()}
    sfx = []
    for ev in sfx_ev:
        if ev[0] == "typing": sfx.append((ev[1], audio.typing(ev[2]) * 0.8))
        elif ev[0] == "click": sfx.append((ev[1], sfx_arr["click"]))
        else: sfx.append((ev[1], sfx_arr[ev[0]] * 0.5))
    total = end + 0.4
    audio.mix(total, [(t, nar[i]) for i, t in voice_ev], sfx, audio.music(total + 2, sc.get("bpm", 76)), "mix.wav")
    final = out_dir / (sc.get("name", "demo") + ".mp4")
    subprocess.run([ff, "-y", "-loglevel", "error", "-i", "silent.mp4", "-i", "mix.wav", "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac",
                    "-b:a", "192k", "-movflags", "+faststart", "-shortest", str(final)], check=True)
    print("wrote", final, f"({round(end, 1)} s)", flush=True)

ap = argparse.ArgumentParser()
ap.add_argument("scenario"); ap.add_argument("--url", required=True); ap.add_argument("--out", required=True)
asyncio.run(main(ap.parse_args()))
