"""A deterministic local web for integration tests: a search engine, a Wikipedia-like site, a Flights-like app,
an image-search page, pages with shadow DOM / iframes / popups / dialogs, a CAPTCHA wall and slow or flaky pages."""

from __future__ import annotations

import base64
import html
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

STATIC = Path(__file__).parent / "fixtures" / "site"

SITES = {
    "python-docs": ("Python 3 documentation — docs.python.org", "docs.python.org", "The official Python documentation: tutorial, library reference, and language reference.", "Welcome to the official Python 3 documentation."),
    "python-mirror": ("Python docs mirror — pydocs.example", "pydocs.example", "An unofficial mirror of old Python documentation.", "Unofficial mirror of Python docs. Not maintained."),
    "python-org": ("Welcome to Python.org", "www.python.org", "The official home of the Python Programming Language.", "Python.org: downloads, docs and community."),
    "models-alpha": ("AlphaMeshes — free 3D models", "alphameshes.example", "Thousands of free 3D models in OBJ and FBX formats. CC0 licence.", "AlphaMeshes hosts 12,000 free 3D models. Formats: OBJ, FBX. Licence: CC0. No sign-up needed."),
    "models-beta": ("BetaForge — free 3D assets", "betaforge.example", "Community 3D assets, game-ready. Creative Commons licences.", "BetaForge offers 8,500 free game-ready assets. Formats: GLB, FBX. Licence: CC-BY. Account required for downloads."),
    "models-gamma": ("GammaSculpt — free sculpt library", "gammasculpt.example", "Free sculpts and STL files for 3D printing.", "GammaSculpt has 30,000 free STL files for printing. Licence: personal use. No account needed."),
    "models-delta": ("DeltaPoly — premium models", "deltapoly.example", "Premium 3D models and a small free section.", "DeltaPoly sells premium models; 200 are free. Formats: MAX, FBX."),
    "models-epsilon": ("Epsilon3D — free models forum", "epsilon3d.example", "A forum thread listing free 3D model sites.", "Epsilon3D forum: thread about free model sites."),
}
QUERY_RESULTS = {
    "python": ["python-mirror", "python-docs", "python-org"],
    "3d": ["models-alpha", "models-beta", "models-gamma", "models-delta", "models-epsilon"],
}

PAGE = "<!doctype html><html lang='en'><head><meta charset='utf-8'><title>{title}</title></head><body>{body}</body></html>"
SVG = "<svg xmlns='http://www.w3.org/2000/svg' width='{w}' height='{w}'><rect width='100%' height='100%' fill='{c}'/><text x='10' y='40' font-size='24'>{n}</text></svg>"


def svg(n: int, w: int) -> str:
    return SVG.format(w=w, c=["#2a9d8f", "#e76f51", "#264653", "#e9c46a", "#8ab17d"][n % 5], n=n)


class FixtureSite:
    def __init__(self) -> None:
        self.hits: list[str] = []
        self.captcha_solved = False
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        self.url = f"http://127.0.0.1:{self.port}"
        self._thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def start(self) -> FixtureSite:
        self._thread.start()
        return self

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def solve_captcha(self) -> None:
        self.captcha_solved = True

    def paths(self) -> list[str]:
        return [urlparse(h).path for h in self.hits]

    def _handler(self):
        site = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def send(self, body: str | bytes, ctype: str = "text/html; charset=utf-8", status: int = 200, headers: dict | None = None):
                data = body if isinstance(body, bytes) else body.encode()
                self.send_response(status)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                for k, v in (headers or {}).items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):  # noqa: N802
                parsed = urlparse(self.path)
                path, qs = parsed.path, parse_qs(parsed.query)
                if path != "/favicon.ico":
                    site.hits.append(self.path)
                if path.startswith("/site/"):
                    file = STATIC / path.removeprefix("/site/")
                    if file.is_file():
                        return self.send(file.read_bytes())
                    return self.send("not found", status=404)
                routes = {"/search": self.search, "/images": self.images, "/wiki": self.wiki_home, "/wiki/search": self.wiki_search,
                          "/captcha": self.captcha, "/captcha/solve": self.solve, "/slow": self.slow, "/stale": self.stale, "/covered": self.covered,
                          "/popup": self.popup, "/dialog": self.dialog, "/shadow": self.shadow, "/frame": self.frame, "/frame-inner": self.frame_inner,
                          "/download/report.txt": self.download, "/hits": self.hits_json, "/": self.index, "/consent": self.consent, "/shop": self.shop}
                if path in routes:
                    return routes[path](qs)
                if path.startswith("/s/"):
                    return self.site_page(path[3:])
                if path.startswith("/img/"):
                    return self.send(svg(int(path[5:].split(".")[0] or 0), 640), "image/svg+xml")
                if path.startswith("/wiki/"):
                    return self.wiki_article(unquote(path[6:]))
                self.send("not found", status=404)

            # Pages -------------------------------------------------------------------------------------------------

            def index(self, _qs):
                self.send(PAGE.format(title="Fixture home", body="<h1>Fixture home</h1><a href='/search?q=python'>search</a>"))

            def search(self, qs):
                q = (qs.get("q", [""])[0]).lower()
                key = next((k for k in QUERY_RESULTS if k in q), "3d" if "model" in q else "python")
                items = []
                for slug in QUERY_RESULTS[key]:
                    title, host, snippet, _text = SITES[slug]
                    items.append(f"<div class='g'><a href='http://{host.replace('www.', '').split('.')[0]}.localhost:{site.port}/s/{slug}'><h3>{html.escape(title)}</h3></a><cite>https://{host}</cite><div>{html.escape(snippet)}</div></div>")
                body = (f"<form action='/search'><input type='search' name='q' aria-label='Search' value='{html.escape(q)}'><button>Search</button></form>"
                        f"<div id='results'>{''.join(items)}</div><a href='/search?q={quote(q)}&p=2'>Next</a>")
                self.send(PAGE.format(title=f"{q} - Fixture Search", body=body))

            def site_page(self, slug):
                if slug in SITES:
                    title, host, _snippet, text = SITES[slug]
                    return self.send(PAGE.format(title=title, body=f"<h1>{html.escape(title)}</h1><p>{html.escape(text)}</p><a href='/'>home</a>"))
                if slug.startswith("img"):
                    return self.send(PAGE.format(title=f"Source page {slug}", body=f"<h1>Photo {slug}</h1>"))
                if slug == "popup-target":
                    return self.send(PAGE.format(title="Popup target", body="<h1>Opened in a new tab</h1>"))
                self.send("not found", status=404)

            def images(self, qs):
                q = qs.get("q", ["palms"])[0]
                tiles = "".join(
                    f"<div class='tile' data-n='{n}' style='display:inline-block;margin:4px'><img width='160' height='160' alt='' "
                    f"src=\"data:image/svg+xml;base64,{base64.b64encode(svg(n, 160).encode()).decode()}\"></div>" for n in range(1, 13))
                ads = "<div class='pla-unit' data-offer-id='1' style='display:inline-block'><img width='160' height='160' alt='' src=\"data:image/svg+xml;base64," + base64.b64encode(svg(99, 160).encode()).decode() + "\"></div>"
                js = """<script>
                  const aside = document.getElementById('panel');
                  document.querySelectorAll('.tile').forEach(t => t.onclick = () => { const n = t.dataset.n;
                    setTimeout(() => { aside.innerHTML = `<img src="/img/${n}.svg" width="400" height="400"><h2>Palm photo ${n}</h2><a href="/s/img${n}">Visit page ${n}</a>`; }, 80); });
                </script>"""
                self.send(PAGE.format(title=f"{q} - Fixture Images", body=f"<div id='grid'>{ads}{tiles}</div><aside id='panel'></aside>{js}"))

            def wiki_home(self, _qs):
                self.send(PAGE.format(title="Fixturepedia", body="<h1>Fixturepedia</h1><form action='/wiki/search'><input type='search' name='q' aria-label='Search Fixturepedia' placeholder='Search Fixturepedia'><button type='submit'>Search</button></form>"))

            def wiki_search(self, qs):
                q = qs.get("q", [""])[0]
                rows = ["Artificial intelligence", "Artificial intelligence in healthcare", "Philosophy of artificial intelligence", "Artificial life"]
                lis = "".join(f"<li><a href='/wiki/{quote(r.replace(' ', '_'))}'>{r}</a></li>" for r in rows)
                self.send(PAGE.format(title=f"Search results for {q} - Fixturepedia", body=f"<h1>Search results</h1><ul>{lis}</ul>"))

            def wiki_article(self, name):
                name = name.replace("_", " ")
                self.send(PAGE.format(title=f"{name} - Fixturepedia", body=f"<h1>{html.escape(name)}</h1><p>{html.escape(name)} is a field of computer science.</p>"))

            def captcha(self, _qs):
                if site.captcha_solved:
                    return self.send(PAGE.format(title="Welcome", body="<h1>Welcome back</h1><p>The pricing is 10 dollars.</p>"))
                self.send(PAGE.format(title="Before you continue", body="<h1>Our systems have detected unusual traffic</h1><p>This page checks to see if it's really you sending the requests, and not a robot. Please verify you are human.</p>"))

            def solve(self, _qs):
                site.solve_captcha()
                self.send("solved", "text/plain")

            def slow(self, _qs):
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                try:
                    self.wfile.write(b"<html><head><title>Slow page</title></head><body><h1>Loading...</h1>")
                    self.wfile.flush()
                    for _ in range(40):
                        time.sleep(0.25)
                        self.wfile.write(b"<p>still going</p>")
                        self.wfile.flush()
                except OSError:
                    pass

            def stale(self, _qs):
                self.send(PAGE.format(title="Stale", body="""<h1>Stale demo</h1><div id='host'></div><p id='out'>waiting</p><script>
                  let n = 0; const host = document.getElementById('host');
                  const render = () => { host.innerHTML = '<button id="go">Confirm order details</button>'; host.firstChild.onclick = () => { document.getElementById('out').textContent = 'clicked'; }; };
                  render(); const t = setInterval(() => { render(); if (++n > 6) clearInterval(t); }, 150);
                </script>"""))

            def covered(self, _qs):
                self.send(PAGE.format(title="Covered", body="""<h1>Covered demo</h1><button id="go" onclick="document.getElementById('out').textContent='clicked'">Reveal</button><p id='out'>waiting</p>
                  <div id="cover" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9">overlay</div>
                  <script>setTimeout(() => document.getElementById('cover').remove(), 900);</script>"""))

            def popup(self, _qs):
                self.send(PAGE.format(title="Popup demo", body="<h1>Popup demo</h1><a href='/s/popup-target' target='_blank'>Open details</a>"))

            def dialog(self, _qs):
                self.send(PAGE.format(title="Dialog demo", body="<h1>Dialog demo</h1><button onclick=\"alert('hello'); document.getElementById('out').textContent='after alert'\">Show notice</button><p id='out'>idle</p>"))

            def shadow(self, _qs):
                self.send(PAGE.format(title="Shadow demo", body="""<h1>Shadow demo</h1><div id="host"></div><p id="out">idle</p><script>
                  const r = document.getElementById('host').attachShadow({mode: 'open'});
                  r.innerHTML = '<button id="in">Shadow action</button>'; r.getElementById('in').onclick = () => { document.getElementById('out').textContent = 'shadow clicked'; };
                </script>"""))

            def frame(self, _qs):
                self.send(PAGE.format(title="Frame demo", body="<h1>Frame demo</h1><p id='out'>idle</p><iframe src='/frame-inner' width='400' height='120' style='border:1px solid #888'></iframe>"))

            def frame_inner(self, _qs):
                self.send(PAGE.format(title="inner", body="<button onclick=\"parent.document.getElementById('out').textContent='frame clicked'\">Frame action</button>"))

            def download(self, _qs):
                self.send("report contents\n", "text/plain", headers={"Content-Disposition": "attachment; filename=report.txt"})

            def consent(self, _qs):
                self.send(PAGE.format(title="Before you continue", body="<h1>Before you continue</h1><p>We use cookies.</p><button onclick=\"document.body.innerHTML='<h1>Consent saved</h1>'\">Reject all</button><button>Accept all</button>"))

            def shop(self, _qs):
                self.send(PAGE.format(title="Shop", body="<h1>Shop</h1><p id='out'>cart: 1 item</p><button onclick=\"document.getElementById('out').textContent='ORDER PLACED'\">Place order</button>"))

            def hits_json(self, _qs):
                self.send(json.dumps(site.hits), "application/json")

        return Handler
