#!/usr/bin/env bash
# Sets up the Kaimono backend from Google Cloud Shell (the terminal in the Firebase or Google Cloud
# console), so it needs no computer: Cloud Shell is already signed in as you.
#
#   git clone https://github.com/SpidyLoke/shopping.git && cd shopping && bash scripts/cloud-shell-setup.sh
#
# It does what the Deploy backend workflow does: turns on the Google APIs, creates the database in
# Singapore, switches on sign-in, makes the backend's API key, deploys the functions and rules, sets up
# auto-deletion of old records, registers the web app and prints the config for firebase-config.js.
# Safe to run again: each step skips what's already done.

set -euo pipefail

PROJECT="${1:-$(gcloud config get-value project 2>/dev/null)}"
REGION=asia-southeast1
FIREBASE="npx -y firebase-tools@15.34.2"
say() { printf '\n\033[1;33m== %s\033[0m\n' "$1"; }
ok() { printf '\033[1;32m✓ %s\033[0m\n' "$1"; }
warn() { printf '\033[1;31m! %s\033[0m\n' "$1"; }

if [ -z "$PROJECT" ]; then
  warn "No project. Run: bash scripts/cloud-shell-setup.sh YOUR-PROJECT-ID"
  exit 1
fi
cd "$(dirname "$0")/.."
say "Kaimono backend for project $PROJECT"

say "1. Blaze plan"
if [ "$(gcloud billing projects describe "$PROJECT" --format='value(billingEnabled)' 2>/dev/null)" != "True" ]; then
  warn "Billing isn't on. In the Firebase console: the gear → Usage and billing → Details & settings → Modify plan → Blaze. Then run this again."
  exit 1
fi
ok "Billing is on"

say "2. Google APIs (a minute or two)"
gcloud services enable --project "$PROJECT" \
  firebase.googleapis.com firestore.googleapis.com identitytoolkit.googleapis.com \
  vision.googleapis.com generativelanguage.googleapis.com \
  secretmanager.googleapis.com apikeys.googleapis.com \
  cloudfunctions.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com run.googleapis.com eventarc.googleapis.com
ok "APIs on"

say "3. Database (Singapore)"
if gcloud firestore databases describe --database='(default)' --project "$PROJECT" >/dev/null 2>&1; then
  ok "Database already there"
else
  gcloud firestore databases create --database='(default)' --location="$REGION" --type=firestore-native --project "$PROJECT"
  ok "Database created"
fi

say "4. Sign-in (anonymous, and email for accounts)"
reply=$(curl -sS -X PATCH \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "X-Goog-User-Project: $PROJECT" -H "Content-Type: application/json" \
  "https://identitytoolkit.googleapis.com/admin/v2/projects/$PROJECT/config?updateMask=signIn.anonymous.enabled,signIn.email.enabled,signIn.email.passwordRequired" \
  -d '{"signIn":{"anonymous":{"enabled":true},"email":{"enabled":true,"passwordRequired":true}}}' || true)
if echo "$reply" | grep -q '"anonymous"'; then
  ok "Anonymous and email sign-in on"
else
  warn "Couldn't switch sign-in on. In the Firebase console: Authentication → Get started, then run this again."
  echo "$reply" | head -c 300
  exit 1
fi

say "5. Firebase CLI"
if ! $FIREBASE projects:list --json >/dev/null 2>&1; then
  echo "Sign the Firebase CLI in: open the link it shows, choose your Google account, copy the code back here."
  $FIREBASE login --no-localhost
fi
ok "Firebase CLI signed in"

secret_set() { gcloud secrets describe "$1" --project "$PROJECT" >/dev/null 2>&1; }
put_secret() {
  f=$(mktemp)
  printf '%s' "$2" > "$f"
  $FIREBASE functions:secrets:set "$1" --data-file "$f" --project "$PROJECT" --non-interactive >/dev/null
  rm -f "$f"
}

say "6. The backend's API key"
if secret_set VISION_KEY && secret_set GEMINI_KEY; then
  ok "Keys already set"
else
  name=$(gcloud services api-keys list --project "$PROJECT" --filter="displayName='Kaimono backend'" --format='value(name)' | head -n1)
  if [ -z "$name" ]; then
    gcloud services api-keys create --project "$PROJECT" --display-name="Kaimono backend" \
      --api-target=service=vision.googleapis.com --api-target=service=generativelanguage.googleapis.com >/dev/null
    name=$(gcloud services api-keys list --project "$PROJECT" --filter="displayName='Kaimono backend'" --format='value(name)' | head -n1)
  fi
  key=$(gcloud services api-keys get-key-string "$name" --format='value(keyString)')
  secret_set VISION_KEY || put_secret VISION_KEY "$key"
  secret_set GEMINI_KEY || put_secret GEMINI_KEY "$key"
  ok "Key made (only works for Vision and Gemini) and stored as secrets"
fi
# The key pair for "your scan is ready" notifications (Web Push).
if ! secret_set VAPID_PUBLIC_KEY || ! secret_set VAPID_PRIVATE_KEY; then
  pair=$(npx -y web-push@3.6.7 generate-vapid-keys --json)
  put_secret VAPID_PUBLIC_KEY "$(printf '%s' "$pair" | node -e "let s='';process.stdin.on('data',(d)=>{s+=d}).on('end',()=>process.stdout.write(JSON.parse(s).publicKey))")"
  put_secret VAPID_PRIVATE_KEY "$(printf '%s' "$pair" | node -e "let s='';process.stdin.on('data',(d)=>{s+=d}).on('end',()=>process.stdout.write(JSON.parse(s).privateKey))")"
  ok "Notification keys made"
fi
# Payments stay off until a Stripe key is added (the Deploy backend workflow, or this script's step 10).
secret_set STRIPE_SECRET_KEY || put_secret STRIPE_SECRET_KEY unset
secret_set STRIPE_WEBHOOK_SECRET || put_secret STRIPE_WEBHOOK_SECRET unset

say "7. Deploy (3 to 5 minutes the first time)"
npm ci --prefix functions --no-audit --no-fund >/dev/null
# A new project's first deploy often fails on a few functions while Google finishes setting up its
# service accounts, or because it creates too many at once. Another go a minute later usually works.
deployed=false
for attempt in 1 2 3; do
  if $FIREBASE deploy --only functions,firestore:rules --project "$PROJECT" --non-interactive --force; then
    deployed=true
    break
  fi
  if [ "$attempt" -lt 3 ]; then
    warn "Some functions didn't deploy (attempt $attempt of 3). Trying again in 90 seconds…"
    sleep 90
  fi
done
if [ "$deployed" != true ]; then
  warn "The deploy still failed. Google's reason (screenshot this for Claude):"
  grep -iE "denied|permission|quota|failed|error" firebase-debug.log | grep -viE "^\s*$|debug\] >" | tail -n 15 || true
  exit 1
fi
ok "Deployed"

# A function made on a retry can be left without public access, and then the app is turned away
# before it runs ("internal" in the app). The app's sign-in token is still checked inside each one.
say "7b. Let the app call every function"
for fn in scan ask result usage report feedback stats plans checkout portal stripeWebhook; do
  gcloud functions add-invoker-policy-binding "$fn" --region="$REGION" --member=allUsers --project "$PROJECT" >/dev/null 2>&1 \
    && echo "  $fn ✓" || warn "  $fn: couldn't set public access (it may not exist yet)"
done

say "8. Old scan results and counters delete themselves"
for group in jobs ipDaily reports feedback events; do
  gcloud firestore fields ttls update expireAt --collection-group="$group" --enable-ttl --async --project "$PROJECT" >/dev/null 2>&1 || true
done
ok "Auto-delete set"

say "9. The app's web config"
if ! grep -q 'export const FIREBASE = null' firebase-config.js; then
  ok "The app is already connected (firebase-config.js). All done."
  exit 0
fi
app=$($FIREBASE apps:list WEB --project "$PROJECT" --json | node .github/scripts/firebase-web-config.mjs app-id)
if [ -z "$app" ]; then
  app=$($FIREBASE apps:create WEB "Kaimono Check" --project "$PROJECT" --json | node .github/scripts/firebase-web-config.mjs created-id)
fi
$FIREBASE apps:sdkconfig WEB "$app" --project "$PROJECT" --json | node .github/scripts/firebase-web-config.mjs write firebase-config.js >/dev/null
config=$(node -e "import('./firebase-config.js').then((m) => console.log(JSON.stringify(m.FIREBASE)))")
ok "Done. Copy the line between the rules and send it to Claude:"
echo "----------------------------------------"
echo "$config"
echo "----------------------------------------"
echo "(It's the project's public web config, safe to share.)"
