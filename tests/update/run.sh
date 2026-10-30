#!/bin/bash
# Update check for the offline cache, over HTTPS like GitHub Pages (which lets browsers keep files
# 10 minutes). Builds three copies of the game: OLD (a git commit, default the last one), NEW (this
# folder as it is now) and NEW2 (NEW with one byte changed, so it is a newer version of the same code).
# usage: tests/update/run.sh [old commit]        (about 3 minutes; needs openssl, python3, playwright)
set -e
cd "$(dirname "$0")/../.."
ROOT=$PWD; HERE=$ROOT/tests/update
WORK=$(mktemp -d); export WORK
trap 'kill $SRV 2>/dev/null; [ -n "$KEEP" ] && echo "kept $WORK" || rm -rf "$WORK"' EXIT
mkdir "$WORK/OLD" "$WORK/NEW"
git archive "${1:-HEAD}" | tar -x -C "$WORK/OLD"
git ls-files --cached --others --exclude-standard | grep -v '^source/\|^build/\|^tests/' | tar -c -T - | tar -x -C "$WORK/NEW"
(cd "$WORK/NEW" && python3 tools/build_sw.py >/dev/null)
cp -a "$WORK/NEW" "$WORK/NEW2" && echo "/* newer */" >> "$WORK/NEW2/css/app.css" && (cd "$WORK/NEW2" && python3 tools/build_sw.py >/dev/null)
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$WORK/key.pem" -out "$WORK/cert.pem" -days 1 -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1" 2>/dev/null
# Chrome trusts this one certificate, so it caches files as it would from a real site
SPKI=$(openssl x509 -in "$WORK/cert.pem" -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64); export SPKI
echo OLD > "$WORK/live"
python3 "$HERE/serve.py" "$WORK" & SRV=$!
sleep 1
ok=0
[ -n "$ONLY" ] && { node "$HERE"/$ONLY || ok=1; exit $ok; }
node "$HERE/run.cjs" OLD NEW plain || ok=1
node "$HERE/run.cjs" NEW NEW2 tap || ok=1
node "$HERE/run.cjs" NEW NEW2 touch || ok=1
node "$HERE/resume.cjs" NEW NEW2 || ok=1
[ $ok = 0 ] && echo "update checks passed" || echo "UPDATE CHECKS FAILED"
exit $ok
