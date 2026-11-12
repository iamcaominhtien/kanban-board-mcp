"""Golden vectors for crates/kb-draw `canvas_html`: `outline` and `title_of` over ordinary and hostile HTML, so the
port of Python's lenient `html.parser` reads a page exactly as the Python server does.

Run from `server/`:  .venv/bin/python ../server-rs/contract/golden/gen_canvas_html.py
Writes `canvas_html.json` next to this file. The generator runs with its own throwaway KANBAN_* folders.
"""

import json
import os
import random
import sys
import tempfile
from pathlib import Path

_tmp = tempfile.mkdtemp(prefix="kb-golden-")
os.environ["KANBAN_CONFIG_DIR"] = os.path.join(_tmp, "config")
os.environ["KANBAN_DB_PATH"] = os.path.join(_tmp, "data", "kanban.db")
os.environ["KANBAN_LOG_DIR"] = os.path.join(_tmp, "logs")
os.environ["KANBAN_UPLOADS_DIR"] = os.path.join(_tmp, "uploads")
sys.path.insert(0, os.getcwd())  # run from server/

from services import canvas_html as ch  # noqa: E402

OUT = Path(__file__).with_name("canvas_html.json")

ORDINARY = [
    "",
    "plain",
    "<!doctype html><html><head><title>Sign in</title><style>body{color:#123}</style></head><body><h1>Sign in</h1>"
    "<label>Email</label><input type=email placeholder=you@example.com><button>Continue</button></body></html>",
    "<h1>Dash &amp; board</h1><p>Rock &amp; roll &lt;3 &copy; 2024 &#169; &#x41;</p>",
    "<title>  A   spaced \n title </title><h1>H</h1>",
    "<TITLE>Upper</TITLE>",
    "<title></title><h2>Second</h2>",
    "<title>   </title><h3>Third heading</h3>",
    "<body><h4>Only heading</h4></body>",
    "<p>no heading</p>",
    "<img alt=\"A logo\"><img><svg></svg><canvas></canvas><video></video><picture></picture>",
    "<input type=submit value=Send><input type=button><input type=hidden name=x><input><textarea placeholder='Notes'>t</textarea><select><option>a</option></select>",
    "<a href=#>link</a> text <button>  Buy  </button> <span>x</span>",
    "<h1>One<br>Two</h1><ul><li>a</li><li>b<ul><li>c</li></ul></li></ul>",
    "<table><tr><td>a</td><th>b</th></tr></table>",
    "<script>var s='<h1>no</h1>';</script><h1>yes</h1><style>h1{}</style>",
    "<noscript><p>no js</p></noscript><p>js</p>",
    "<div><div><div>deep</div></div></div>",
    "<p>a</p><p>b</p><p>c</p>",
    "<p>" + "word " * 500 + "</p>",
    "<b>bold</b> and <i>italic</i> inline text",
    "<h1 class='a b' id=x data-x=\"1\">Attrs</h1>",
    "<a title=\"x\">y</a><a title='x'>y</a><a title=x>y</a>",
    "<p>café 中文 \U0001f600</p>",
    "<h1> nbsp </h1>",
    "<title>A &amp; B &lt;c&gt;</title>",
    "<title>" + "x" * 300 + "</title>",
    "<h1>" + "y" * 300 + "</h1>",
]

HOSTILE = [
    "<", "<a", "<a ", "<a b", "<a b=", "<a b='", "<a b='x", "<a b='x'", "<a b='x' ", "<a b=\"x", "<a b=x",
    "<a b= 'x", "<a b= \"x", "<a b= x", "<a =x>", "<a ==x>", "<a b=>", "<a b= >", "<a/>", "<a />", "<a/ >",
    "<a b/>", "<a b=c/>", "<a b='c'/>", "<a/b>", "<a//b>", "<a / / >", "<a\x00b>x</a\x00b>",
    "</", "</a", "</a>", "</ a>", "</>", "</ >", "</a b>", "</a b='>", "</1>", "</-x>", "</a/>",
    "<!", "<!-", "<!--", "<!-->", "<!--->", "<!---->", "<!-- x", "<!-- x -->", "<!-- x --!>", "<!-- x --", "<!-- x -",
    "<!--x--!", "<!---x-->", "<!--a--b-->", "<!--a--!b-->", "<!-- -- -->",
    "<!>", "<!x>", "<!doctype", "<!doctype html", "<!doctype html>", "<!DOCTYPE html>", "<!DocType>",
    "<![CDATA[", "<![CDATA[x", "<![CDATA[x]]>", "<![CDATA[x]]", "<![if IE]>", "<![endif]>", "<![x", "<![x>",
    "<?", "<?x", "<?x>", "<?php echo 1 ?>", "<?xml version='1.0'?>",
    "<script>", "<script>x", "<script>x</", "<script>x</script", "<script>x</script>", "<script>x</SCRIPT >y",
    "<script>x</scriptx>y</script>z", "<script><!--", "<script><h1>x</h1></script><h1>y</h1>",
    "<style>", "<style>a</style", "<style>h1{}</style><h1>a</h1>",
    "<title>", "<title>a", "<title>a</title", "<title>&amp;</title>", "<title><b>x</b></title>", "<title>a</title><h1>b</h1>",
    "<textarea>", "<textarea><b>x</b></textarea>y", "<textarea>&lt;</textarea>",
    "<xmp><h1>x</h1></xmp>", "<iframe><h1>x</h1></iframe>", "<noembed>x</noembed>", "<noframes>x</noframes>",
    "<plaintext><h1>x</h1>", "<plaintext>", "<noscript><h1>x</h1></noscript>",
    "&", "&a", "&amp", "&amp;", "&#", "&#x", "&#65", "&#65;", "&#x41", "&#xZZ;", "&#99999999;", "&#0;", "&#128;",
    "a & b", "&notit;", "&foo;", "x&", "x&a", "x &amp", "x &#6", "a" * 40 + "&amp", "a" * 40 + "&am",
    "<p>a &amp b</p>", "<p>&#", "<p>&", "<p>&amp",
    "<a b=\"&amp;\">", "<a b='&lt;x&gt;'>t</a>", "<input placeholder=\"&quot;q&quot;\">",
    "<a b=c d='e' f=\"g\" h>", "<a  b  =  c  >", "<a b=c\td=e>", "<a\tb=c>", "<a\nb=c>", "<a\fb=c>",
    "<a b='c'd='e'>", "<a b='c'\"d\">", "<a 'b'>", "<a \"b\">", "<a b=\"c\"\"d\">",
    "<p<a>x</a>", "<p<h1>x</h1>>", "<<h1>x</h1>", "<h1>>x</h1>", "<h1<>x</h1>",
    "<h1>a</h2>b</h1>", "</h1>a", "</p></p><p>x", "<p><p><p>x</p>", "<b><p>x</b></p>",
    "<h1><h2>a</h1>b</h2>", "<button><a>x</a></button>", "<a><button>x</button></a>", "<h1><button>x</button></h1>",
    "<button><h1>x</h1></button>", "<a><h1>x</h1></a>",
    "<input type=SUBMIT value=x>", "<input type=' submit'>", "<input type=submit>", "<input type=button value=''>",
    "<input placeholder>", "<input placeholder=''>", "<input type placeholder=x>", "<input type=hidden placeholder=x>",
    "<img alt>", "<img alt=''>", "<img ALT=Caps>", "<IMG alt=x>", "<svg alt=x>", "<video alt=y></video>",
    "<br/><br><hr/>text", "<br>x</br>y", "<p/>x", "<h1/>x</h1>",
    "<title/>x<h1>y</h1>", "<head><h1>hidden</h1></head><h1>shown</h1>", "<head><title>t</title></head>",
    "<style/>x", "<noscript/><h1>x</h1>",
    "<html><head><style>x", "<html><head></head><body><h1>x", "\n\n<h1>\n x \n</h1>\n\n",
    "﻿<h1>bom</h1>", "<h1>\u0000nul</h1>", "<h1>tab\there</h1>",
    "<a href=x>" * 50, "<div>" * 200 + "x", "<h1>" * 100, "<" * 100, "<a " * 100, "&" * 100, "<!--" * 50, "<![CDATA[" * 20,
    "<a b='" + "x" * 5000, "<a " + "b " * 2000 + ">x", "<h1 " + "a=1 " * 1000 + ">t</h1>",
    "<title>x</title >", "< title>x</title>", "<title\n>x</title\n>", "<Title>x</tItLe>", "<title>İ</title>",
    "<tİtle>x</title>", "<tıtle>x</title>", "<title>x</tıtle>", "<title>x</tİtle>", "<title>x</tİtle>",
    "<title >a</title><title>b</title>", "<title></title><title>b</title>", "<titlex>a</title>", "<title/>a</title>",
    "<title>a<title>b</title>", "<title>a</title>b</title>", "<title>a</TITLE>", "<title\x00>a</title>",
    "<title>&#x3C;h1&#x3E;</title>", "<title>a b</title>", "<title>\x1ca\x1d</title>", "<title>　a　</title>",
]

CASES = list(ORDINARY) + HOSTILE
rng = random.Random(41)
TOKENS = [
    "<", ">", "</", "/>", "<a", "<p>", "</p>", "<h1>", "</h1>", "<h2>", "<button>", "</button>", "<input", " type=submit",
    " value=go", " placeholder=x", "<img", " alt=a", "<title>", "</title>", "<script>", "</script>", "<style>", "</style>",
    "<textarea>", "</textarea>", "<!--", "-->", "--!>", "<![CDATA[", "]]>", "<!doctype html>", "<?", "?>", "=", "'", "\"",
    " ", "\n", "\t", "&amp;", "&", "&#65;", "&#x", ";", "text ", "word", "x", "<b>", "</b>", "<div>", "</div>", "<span>",
    "<li>", "<br>", "<svg>", "</svg>", "<noscript>", "</noscript>", "<head>", "</head>", "<plaintext>", "<xmp>", "</xmp>",
    "İ", "ı", "é", "中", "\x00", "\x0c", "\r", "<a href=x>", "</a>", "<label>", "<td>",
]
for _ in range(500):
    CASES.append("".join(rng.choice(TOKENS) for _ in range(rng.randrange(1, 40))))

cases = []
for source in CASES:
    cases.append({
        "source": source,
        "outline": [list(x) for x in ch.outline(source)],
        "title": ch.title_of(source),
        "title_fb": ch.title_of(source, "Fallback"),
    })

OUT.write_text(json.dumps({"cases": cases}, separators=(",", ":"), ensure_ascii=True))
print(OUT, OUT.stat().st_size, len(cases))
