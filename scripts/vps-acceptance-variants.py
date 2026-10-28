"""Create clearly labelled synthetic release variants from real built OCI images.

No registry, no production data: labels change the API digest, small added Web
assets exercise retention, and a deliberately broken API CMD corrupts only the
fresh test installation to exercise recovery. This is NOT version compatibility.
"""
import hashlib
import io
import json
import pathlib
import subprocess
import sys
import tarfile

root = pathlib.Path(sys.argv[1])
if not root.name.startswith('wangke-separation-check.'):
    raise RuntimeError('isolated_test_root_required')


def encode(value):
    return json.dumps(value, separators=(',', ':')).encode()


def variant(base, name, asset=None, broken=False):
    saved = root / f'{base}-saved.tar'
    if not saved.exists():
        with saved.open('wb') as output:
            subprocess.run(['docker', 'save', f'{base}:zz0q2b95'], stdout=output, check=True)
    with tarfile.open(saved) as archive:
        index = json.loads(archive.extractfile('index.json').read())
        descriptor = index['manifests'][0]
        manifest = json.loads(archive.extractfile('blobs/sha256/' + descriptor['digest'].split(':')[1]).read())
        while 'manifests' in manifest:
            descriptor = next(m for m in manifest['manifests'] if m.get('platform', {}).get('architecture') == 'amd64')
            manifest = json.loads(archive.extractfile('blobs/sha256/' + descriptor['digest'].split(':')[1]).read())
        config = json.loads(archive.extractfile('blobs/sha256/' + manifest['config']['digest'].split(':')[1]).read())
    blobs = {}
    config['config'].setdefault('Labels', {})['wangke.acceptance.synthetic'] = name
    if broken:
        config['config']['Cmd'] = ['node', '--input-type=module', '-e', "import Database from 'better-sqlite3';import fs from 'node:fs';const db=new Database('/data/db/wangke.sqlite');db.exec(\"CREATE TABLE IF NOT EXISTS acceptance_partial_migration(x); UPDATE users SET name='acceptance-corrupted-name'\");db.close();for(const name of fs.readdirSync('/data/files')){if(name.endsWith('.bin'))fs.writeFileSync('/data/files/'+name,'intentionally broken isolated test bytes');}await fetch('http://proof-model:9000/migration-hit',{signal:AbortSignal.timeout(3000)});process.exit(42)"]
    if asset:
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w') as layer:
            payload = b'/* isolated synthetic asset retention proof */\n'
            info = tarfile.TarInfo('opt/web-assets/' + asset)
            info.size = len(payload)
            info.mode = 0o644
            layer.addfile(info, io.BytesIO(payload))
        raw = buffer.getvalue()
        digest = hashlib.sha256(raw).hexdigest()
        blobs['blobs/sha256/' + digest] = raw
        manifest['layers'].append({'mediaType': 'application/vnd.oci.image.layer.v1.tar', 'digest': 'sha256:' + digest, 'size': len(raw)})
        config['rootfs']['diff_ids'].append('sha256:' + digest)
    raw = encode(config)
    digest = hashlib.sha256(raw).hexdigest()
    blobs['blobs/sha256/' + digest] = raw
    manifest['config'].update(digest='sha256:' + digest, size=len(raw))
    raw = encode(manifest)
    digest = hashlib.sha256(raw).hexdigest()
    blobs['blobs/sha256/' + digest] = raw
    descriptor = {'mediaType': manifest['mediaType'], 'digest': 'sha256:' + digest, 'size': len(raw), 'annotations': {'io.containerd.image.name': f'docker.io/library/{name}:zz0q2b95', 'org.opencontainers.image.ref.name': f'{name}:zz0q2b95'}}
    output = root / f'{name}.oci.tar'
    with tarfile.open(output, 'w') as archive:
        with tarfile.open(saved) as original:
            for entry in original:
                if entry.isfile() and entry.name.startswith('blobs/') and entry.name not in blobs:
                    archive.addfile(entry, original.extractfile(entry))
        entries = {**blobs, 'oci-layout': encode({'imageLayoutVersion': '1.0.0'}), 'index.json': encode({'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.index.v1+json', 'manifests': [descriptor]})}
        for filename, contents in entries.items():
            info = tarfile.TarInfo(filename)
            info.size = len(contents)
            archive.addfile(info, io.BytesIO(contents))
    subprocess.run(['docker', 'load', '-i', str(output)], check=True)
    print(name, descriptor['digest'], flush=True)
    output.unlink()  # Only this helper's generated transport archive.


variant('wk-check-api', 'wk-check-api-base')
variant('wk-check-api', 'wk-check-api-next')
variant('wk-check-api', 'wk-check-api-bad', broken=True)
variant('wk-check-web', 'wk-check-web-old', asset='wk-old-proof.js')
variant('wk-check-web', 'wk-check-web-next', asset='wk-new-proof.js')
