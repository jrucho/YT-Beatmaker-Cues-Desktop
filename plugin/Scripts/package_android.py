"""Verify and package the signed Android JUCE standalone, with source provenance."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import zipfile
from source_info import source_info

parser = argparse.ArgumentParser()
parser.add_argument('--apk', required=True)
parser.add_argument('--output', default='release')
parser.add_argument('--checks', default='native-build,apk-signature')
parser.add_argument('--latency-report', action='append', default=[], help='Attach a measured benchmark JSON to the build record')
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
version = json.loads((root / 'package.json').read_text())['version']
apk = Path(args.apk).resolve()
sdk = Path(os.environ.get('ANDROID_HOME', os.environ.get('ANDROID_SDK_ROOT', '')))
signer = sdk / 'build-tools/36.0.0/apksigner'
badging = subprocess.check_output([str(sdk / 'build-tools/36.0.0/aapt2'), 'dump', 'badging', str(apk)], text=True)
if not re.search(r"package: name='app\.owaega\.beatmakercuesstandalone'", badging):
    raise RuntimeError('Public APK must use the normal application ID, not an internal latency probe')
if 'application-debuggable' in badging:
    raise RuntimeError('Package the non-debuggable release APK')
parts = [int(part) for part in version.split('.')]
code = parts[0] * 10000 + parts[1] * 100 + parts[2]
if f"versionName='{version}'" not in badging or f"versionCode='{code}'" not in badging:
    raise RuntimeError('APK version must match the source release')
verification = subprocess.check_output([str(signer), 'verify', '--verbose', '--print-certs', str(apk)], text=True)
certificate = re.search(r'Signer #1 certificate SHA-256 digest: ([0-9a-f]+)', verification)
if not certificate:
    raise RuntimeError('Missing APK signing certificate')
expected = (root / 'mobile/android/release-certificate.sha256').read_text().strip().lower()
if certificate.group(1) != expected:
    raise RuntimeError('Standalone must use the persistent Android release certificate')
with zipfile.ZipFile(apk) as archive:
    libraries = [name for name in archive.namelist() if name.startswith('lib/') and name.endswith('.so')]
    if libraries != ['lib/arm64-v8a/libjuce_jni.so']:
        raise RuntimeError(f'Unexpected native libraries: {libraries}')
    native = archive.read(libraries[0])
    if len(native) < 20 or native[:4] != b'\x7fELF' or native[4] != 2 or int.from_bytes(native[18:20], 'little') != 183:
        raise RuntimeError('Missing real arm64 native ELF binary')
output = Path(args.output).resolve()
output.mkdir(parents=True, exist_ok=True)
target = output / f'Beatmaker-Cues-{version}-Android-arm64.apk'
shutil.copy2(apk, target)
info = dict(version=version, productName='Beatmaker Cues', platform='Android', architecture='arm64-v8a', edition='main',
            applicationId='app.owaega.beatmakercuesstandalone', formats=['Standalone'],
            signing='persistent-release-key', certificateSha256=certificate.group(1),
            checks=args.checks.split(','), **source_info(root))
if args.latency_report:
    info['latencyMeasurements'] = []
    for name in args.latency_report:
        report = Path(name)
        payload = report.read_bytes()
        result = json.loads(payload)
        if result.get('input') != 'Android input motionevent DOWN/UP' or not result.get('nativeSamplesMs'):
            raise RuntimeError('Expected a real Android MotionEvent benchmark report')
        info['latencyMeasurements'].append(dict(report=report.name, sha256=hashlib.sha256(payload).hexdigest(), result=result))
record = output / f'Plugin-Build-{version}-Android-arm64.json'
record.write_text(json.dumps(info, indent=2) + '\n')
checksums = output / f'SHA256SUMS-Plugins-{version}-Android-arm64.txt'
checksums.write_text(''.join(hashlib.sha256(file.read_bytes()).hexdigest() + '  ' + file.name + '\n'
                             for file in [target, record]))
for file in [target, record, checksums]:
    print(file)
