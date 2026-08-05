#!/usr/bin/env bash
# Verify that a TradeTally production deploy actually serves expected code.
#
# Checks:
#   1) /api/health is OK
#   2) /api/build commit matches expected SHA (origin/production by default)
#   3) Railway latest deployment is SUCCESS with the same commit (if CLI linked)
#   4) Live JS graph contains required feature markers (proves frontend shipped)
#   5) Custom domain journal.sworihow.com resolves to the live app (warns if not)
#
# Usage:
#   scripts/verify-deploy.sh
#   scripts/verify-deploy.sh --expect 6310149e
#   scripts/verify-deploy.sh --marker 'daily-review' --marker 'DailyReviewWidget'

set -euo pipefail

BASE_URL="${VERIFY_BASE_URL:-https://tradetally-app-production.up.railway.app}"
CUSTOM_DOMAIN="${VERIFY_CUSTOM_DOMAIN:-https://journal.sworihow.com}"
EXPECT_SHA=""
MARKERS=()
STRICT_DOMAIN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url) BASE_URL="$2"; shift 2 ;;
    --custom-domain) CUSTOM_DOMAIN="$2"; shift 2 ;;
    --expect|--sha) EXPECT_SHA="$2"; shift 2 ;;
    --marker) MARKERS+=("$2"); shift 2 ;;
    --strict-domain) STRICT_DOMAIN=1; shift ;;
    -h|--help)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

if [[ ${#MARKERS[@]} -eq 0 ]]; then
  MARKERS=(
    'daily-review'
    'DailyReviewWidget'
    'Open full review'
  )
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -z "$EXPECT_SHA" ]]; then
  git fetch origin production --quiet 2>/dev/null || true
  EXPECT_SHA="$(git rev-parse origin/production 2>/dev/null || git rev-parse HEAD)"
fi
EXPECT_SHORT="${EXPECT_SHA:0:8}"

pass=0
fail=0
warn=0

ok()   { pass=$((pass + 1)); echo "✓ $*"; }
bad()  { fail=$((fail + 1)); echo "✗ $*" >&2; }
note() { warn=$((warn + 1)); echo "! $*"; }

sha_matches() {
  local got="$1" want="$2"
  [[ -n "$got" && -n "$want" ]] || return 1
  [[ "$got" == "$want"* || "$want" == "$got"* ]]
}

echo "Verifying deploy"
echo "  base:     $BASE_URL"
echo "  expect:   $EXPECT_SHA"
echo "  domain:   $CUSTOM_DOMAIN"
echo

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# --- 1) Health ---
if health_json="$(curl -fsS --max-time 20 "$BASE_URL/api/health" 2>/dev/null)"; then
  if [[ "$health_json" == *'"status":"OK"'* || "$health_json" == *'"status": "OK"'* ]]; then
    ok "health OK"
  else
    bad "health unexpected payload: $health_json"
  fi
else
  bad "health request failed"
fi

# --- 2) Build commit from the running app ---
if build_json="$(curl -fsS --max-time 20 "$BASE_URL/api/build" 2>/dev/null)"; then
  build_commit="$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("commit") or "")' <<<"$build_json" 2>/dev/null || true)"
  if [[ -n "$build_commit" ]] && sha_matches "$build_commit" "$EXPECT_SHA"; then
    ok "api/build commit matches ($build_commit)"
  elif [[ -n "$build_commit" ]]; then
    bad "api/build commit mismatch: got $build_commit want $EXPECT_SHORT…"
  else
    note "api/build returned empty commit (older image without RAILWAY_GIT_COMMIT_SHA)"
  fi
else
  note "api/build unavailable (deploy predates endpoint); using Railway + asset checks"
fi

# --- 3) Railway deployment meta (optional) ---
if command -v railway >/dev/null 2>&1; then
  if railway deployment list --json >"$tmp/rail.json" 2>/dev/null; then
    rail_status="$(python3 -c 'import json,pathlib; print(json.loads(pathlib.Path("'"$tmp/rail.json"'").read_text())[0].get("status") or "")')"
    rail_commit="$(python3 -c 'import json,pathlib; print((json.loads(pathlib.Path("'"$tmp/rail.json"'").read_text())[0].get("meta") or {}).get("commitHash") or "")')"
    rail_msg="$(python3 -c 'import json,pathlib; m=(json.loads(pathlib.Path("'"$tmp/rail.json"'").read_text())[0].get("meta") or {}).get("commitMessage") or ""; print(m.splitlines()[0] if m else "")')"
    if [[ "$rail_status" == "SUCCESS" ]]; then
      ok "railway deployment SUCCESS"
    else
      bad "railway deployment status is ${rail_status:-unknown} (want SUCCESS)"
    fi
    if sha_matches "$rail_commit" "$EXPECT_SHA"; then
      ok "railway commit matches (${rail_commit}) — ${rail_msg}"
    elif [[ -n "$rail_commit" ]]; then
      bad "railway commit mismatch: got ${rail_commit} want ${EXPECT_SHORT}…"
    else
      note "railway deployment has no commitHash"
    fi
  else
    note "railway CLI could not list deployments (link/project context?)"
  fi
else
  note "railway CLI not installed; skipped deployment meta check"
fi

# --- 4) Frontend asset graph contains markers ---
if html="$(curl -fsS --max-time 20 "$BASE_URL/" 2>/dev/null)"; then
  index_path="$(python3 -c 'import re,sys; m=re.search(r"src=\"(/assets/index-[^\"]+\.js)\"", sys.stdin.read()); print(m.group(1) if m else "")' <<<"$html")"
  if [[ -z "$index_path" ]]; then
    bad "no /assets/index-*.js in HTML"
  else
    ok "index bundle $index_path"
    marker_args=()
    for m in "${MARKERS[@]}"; do
      marker_args+=(--marker "$m")
    done
    if python3 - <<'PY' "$BASE_URL" "$index_path" "${MARKERS[@]}"
import re, sys, urllib.request
from collections import deque

base, index_path, *markers = sys.argv[1:]
asset_re = re.compile(r"(?:\.?/)?assets/[^\"']+\.js")

def fetch(path: str) -> str:
    url = base.rstrip("/") + (path if path.startswith("/") else "/" + path)
    with urllib.request.urlopen(url, timeout=30) as r:
        return r.read().decode("utf-8", "replace")

# BFS through dynamic-import chunks so lazy widgets (e.g. DailyReviewWidget)
# are included even when only referenced from a route chunk.
queue = deque([index_path.lstrip("/")])
seen = set()
found = {m: False for m in markers}
while queue and not all(found.values()):
    path = queue.popleft()
    key = path.lstrip("./")
    if key in seen:
        continue
    seen.add(key)
    try:
        data = fetch(key if key.startswith("assets/") or key.startswith("/") else "/" + key)
    except Exception:
        continue
    for m in markers:
        if not found[m] and m in data:
            found[m] = True
    if all(found.values()):
        break
    for match in asset_re.findall(data):
        norm = match[2:] if match.startswith("./") else match
        norm = norm.lstrip("/")
        if norm not in seen:
            queue.append(norm)

failed = False
for m in markers:
    if found[m]:
        print(f"ok\t{m}")
    else:
        failed = True
        print(f"miss\t{m}", file=sys.stderr)
sys.exit(1 if failed else 0)
PY
    then
      for m in "${MARKERS[@]}"; do
        ok "frontend marker present: $m"
      done
    else
      bad "frontend markers missing from live JS (want: ${MARKERS[*]})"
    fi
  fi
else
  bad "could not fetch $BASE_URL/"
fi

# --- 5) Custom domain ---
domain_host="$(echo "$CUSTOM_DOMAIN" | sed -E 's#https?://##; s#/.*##')"
domain_code="$(curl -sS -o "$tmp/domain.html" -w '%{http_code}' --max-time 20 -k "$CUSTOM_DOMAIN/" || echo '000')"
domain_index="$(rg -o 'index-[^"]+\.js' "$tmp/domain.html" 2>/dev/null | head -1 || true)"
cname="$(dig +short "$domain_host" CNAME | head -1 || true)"
if [[ "$domain_code" == "200" && -n "$domain_index" ]]; then
  ok "custom domain serves app (HTTP $domain_code, $domain_index)"
elif [[ "$domain_code" == "200" ]]; then
  note "custom domain HTTP 200 but no index bundle detected"
else
  msg="custom domain not serving app (HTTP $domain_code"
  [[ -n "$cname" ]] && msg+=", CNAME=$cname"
  msg+=") — open $BASE_URL/dashboard until DNS/cert is fixed"
  if [[ $STRICT_DOMAIN -eq 1 ]]; then
    bad "$msg"
  else
    note "$msg"
  fi
fi

echo
echo "Result: $pass passed, $warn warnings, $fail failed"
if [[ $fail -gt 0 ]]; then
  exit 1
fi
exit 0
