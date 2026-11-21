"""Recover license texts for versions actually embedded in the published Mermaid browser build."""
import argparse
import base64
import concurrent.futures
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import os
import tarfile
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[2]
LICENSES = ROOT / 'Resources/vendor/licenses'
LOCK = Path(__file__).with_name('mermaid-notice-sources.json')
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--refresh', action='store_true', help='record upstream digests after reviewing a dependency update')
parser.add_argument('--archive', type=Path, help='read the sourcemap from an npm tarball instead of node_modules')
args = parser.parse_args()


def request(url):
    cache = os.environ.get('SAMARE_NOTICE_CACHE')
    if cache:
        path = Path(cache) / hashlib.sha256(url.encode()).hexdigest()
        if path.is_file():
            return path.read_bytes()
    data = subprocess.check_output(['curl', '--fail', '--silent', '--show-error', '--location', '--retry', '4',
                                    '--retry-all-errors', '--connect-timeout','10','--max-time','60',url])
    if cache:
        path.parent.mkdir(parents=True,exist_ok=True)
        path.write_bytes(data)
    return data


def map_versions():
    if args.archive:
        with tarfile.open(args.archive) as dist:
            manifest = json.load(dist.extractfile('package/package.json'))
            source_map = json.load(dist.extractfile('package/dist/mermaid.min.js.map'))
    else:
        source = ROOT / 'node_modules/mermaid'
        manifest = json.loads((source/'package.json').read_text())
        source_map = json.loads((source/'dist/mermaid.min.js.map').read_text())
    # Inner webpack modules and workspace packages have no npm version in the sourcemap.
    # The parser version is from the Mermaid 11.12.1 tag. All eight sources from
    # vscode-uri 3.1.0’s ESM sourcemap match the Mermaid sourcemap byte-for-byte.
    # webpack and path-browserify are pinned by microsoft/vscode-uri v3.1.0/yarn.lock.
    if manifest['version'] != '11.12.1':
        raise ValueError('Review the embedded parser, webpack and vscode-uri versions before changing Mermaid.')
    names = {('mermaid',manifest['version']),('@mermaid-js/parser','0.6.3'),
             ('path-browserify','1.0.1'),('vscode-uri','3.1.0'),('webpack','5.94.0')}
    for source in source_map['sources']:
        match = re.search(r'/\.pnpm/([^/]+)/node_modules/((?:@[^/]+/)?[^/]+)',source)
        if match:
            name = match[2]
            prefix = name.replace('/','+')+'@'
            if not match[1].startswith(prefix):
                raise ValueError(source)
            version = match[1][len(prefix):].split('_')[0]
            names.add((name,version))
    return sorted(names)


def package_notices(pair):
    name,version = pair
    label = name+'@'+version
    known = pinned.get(label,{})
    if known and not args.refresh:
        url,integrity = known['tarball'], known['integrity']
    else:
        registry = 'https://registry.npmjs.org/'+quote(name,safe='@')+'/'+version
        metadata = json.loads(request(registry))
        url,integrity = metadata['dist']['tarball'],metadata['dist']['integrity']
    archive = request(url)
    algorithm,digest = integrity.split('-',1)
    if base64.b64encode(hashlib.new(algorithm,archive).digest()).decode()!=digest:
        raise ValueError('Archive integrity mismatch: '+label)
    with tarfile.open(fileobj=io.BytesIO(archive),mode='r:gz') as dist:
        manifest = json.load(dist.extractfile('package/package.json'))
        files = {}
        for item in dist.getmembers():
            p = Path(item.name)
            if not item.isfile() or p.parts[0]!='package':
                continue
            root_notice = len(p.parts)==2 and re.match(r'^(licen[cs]e|copying|notice|copyright)(?:[.-].*)?$',p.name,re.I)
            sub_notice = len(p.parts)==3 and p.parts[1].lower() in ('licenses','licences')
            if root_notice or sub_notice:
                files[str(p.relative_to('package'))] = dist.extractfile(item).read().decode('utf-8-sig',errors='replace').strip()
        if not files:
            raise ValueError(label+' includes no upstream license text')
    entry = {'tarball':url,'integrity':integrity,'license':manifest.get('license','see text')}
    if name == 'webpack':
        entry['role']='Compiler runtime included in vscode-uri 3.1.0; version from microsoft/vscode-uri v3.1.0/yarn.lock.'
    return label, entry, '\n\n'.join(f'{n}\n{text}' for n,text in sorted(files.items()))


pinned = json.loads(LOCK.read_text()) if LOCK.exists() else {}
packages=map_versions()
if not args.refresh and set(pinned)!={n+'@'+v for n,v in packages}:
    raise SystemExit('Mermaid sourcemap and notice lock differ. Review and run with --refresh.')
with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
    notices=list(pool.map(package_notices,packages))
entries = {label:entry for label,entry,text in notices}
out = 'Upstream notices for the Mermaid 11.12.1 browser bundle\n\n' + '\n\n'.join(
    f'{label}\nSource: {entry["tarball"]}\n' + (entry['role']+'\n' if 'role' in entry else '') + '\n'+text for label,entry,text in notices)+'\n'
LICENSES.mkdir(parents=True,exist_ok=True)
(LICENSES/'mermaid-bundled.txt').write_text(out)
if args.refresh:
    LOCK.write_text(json.dumps(entries,indent=2,sort_keys=True)+'\n')
print(f'{len(entries)} verified upstream archives, {len(out)} characters of license notices.')
