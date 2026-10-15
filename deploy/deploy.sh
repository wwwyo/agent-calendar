#!/usr/bin/env bash
# Cloud Run への deploy と Cloud Scheduler の job 作成（何度流しても同じ状態になる）
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT=agent-calendar-wwwyo
REGION=asia-northeast1
SERVICE=agent-calendar
SA=runner@${PROJECT}.iam.gserviceaccount.com
WORKSPACES_FILE=${WORKSPACES_FILE:-deploy/workspaces.demo.json}
PN=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
URL="https://${SERVICE}-${PN}.${REGION}.run.app"

ENV_FILE=$(mktemp)
trap 'rm -f "$ENV_FILE"' EXIT
python3 - "$WORKSPACES_FILE" "$ENV_FILE" "$PROJECT" "$URL" "$SA" <<'PY'
import json, sys
src, out, project, url, sa = sys.argv[1:]
env = {
  "GCP_PROJECT": project,
  "VERTEX_LOCATION": "us-central1",
  "GEMINI_MODEL": "gemini-2.5-flash",
  "WORKSPACES": json.dumps(json.load(open(src)), ensure_ascii=False),
  "STORE": "firestore",
  "TICK_AUTH": "oidc",
  "TICK_AUDIENCE": url,
  "TICK_INVOKER_EMAIL": sa,
}
json.dump(env, open(out, "w"), ensure_ascii=False)
PY

gcloud run deploy "$SERVICE" --project "$PROJECT" --region "$REGION" --source . \
  --service-account "$SA" --env-vars-file "$ENV_FILE" \
  --allow-unauthenticated --min-instances 0 --max-instances 2 --concurrency 20 \
  --cpu 1 --memory 512Mi --timeout 300 --quiet

if gcloud scheduler jobs describe tick --project "$PROJECT" --location "$REGION" >/dev/null 2>&1; then
  verb=update
else
  verb=create
fi
gcloud scheduler jobs "$verb" http tick --project "$PROJECT" --location "$REGION" \
  --schedule "* * * * *" --time-zone "Asia/Tokyo" --uri "${URL}/tick" --http-method POST \
  --oidc-service-account-email "$SA" --oidc-token-audience "$URL" --attempt-deadline 300s --quiet

echo "$URL"
