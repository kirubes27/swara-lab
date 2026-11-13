#!/usr/bin/env python3
"""Stamp each script with a hash of its content.

GitHub Pages lets browsers keep files for 10 minutes, so right after an update a browser could
run a mix of old and new scripts. The import map in index.html gives every script an address
with its hash (?v=...): a changed file is fetched fresh, an unchanged one stays cached.

Run before publishing:  python3 tools/stamp.py
"""
import hashlib
import json
import pathlib
import re

root = pathlib.Path(__file__).resolve().parent.parent
stamps = {f.name: hashlib.sha1(f.read_bytes()).hexdigest()[:8] for f in sorted((root / 'js').glob('*.js'))}
imports = {f'./js/{name}': f'./js/{name}?v={h}' for name, h in stamps.items()}
block = '<script type="importmap">' + json.dumps({'imports': imports}, separators=(',', ':')) + '</script>'
entry = f'<script type="module" src="js/app.js?v={stamps["app.js"]}"></script>'

page = root / 'index.html'
html = page.read_text()
html, found = re.subn(r'<script type="importmap">.*?</script>', lambda m: block, html, flags=re.S)
html, n = re.subn(r'<script type="module" src="js/app\.js(\?v=\w+)?"></script>', lambda m: entry if found else block + '\n' + entry, html)
if n != 1:
    raise SystemExit('index.html: the app.js script tag was not found')
page.write_text(html)
print(f'stamped {len(stamps)} scripts')
