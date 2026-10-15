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
# cloud の回を動かす Cloud Run Job。Vertex AI の model と同じ us-central1 に置く
SANDBOX_REGION=us-central1
SANDBOX_JOB_NAME=agent-sandbox
SANDBOX_JOB="projects/${PROJECT}/locations/${SANDBOX_REGION}/jobs/${SANDBOX_JOB_NAME}"
SANDBOX_SA=sandbox@${PROJECT}.iam.gserviceaccount.com

ENV_FILE=$(mktemp)
trap 'rm -f "$ENV_FILE"' EXIT
python3 - "$WORKSPACES_FILE" "$ENV_FILE" "$PROJECT" "$URL" "$SA" "$SANDBOX_JOB" <<'PY'
import json, sys
src, out, project, url, sa, sandbox_job = sys.argv[1:]
env = {
  "GCP_PROJECT": project,
  "VERTEX_LOCATION": "us-central1",
  "GEMINI_MODEL": "gemini-2.5-flash",
  "WORKSPACES": json.dumps(json.load(open(src)), ensure_ascii=False),
  "STORE": "firestore",
  "TICK_AUTH": "oidc",
  "TICK_AUDIENCE": url,
  "TICK_INVOKER_EMAIL": sa,
  "SANDBOX_JOB": sandbox_job,
  "RUNNER_URL": url,
}
json.dump(env, open(out, "w"), ensure_ascii=False)
PY

# sandbox の service account。role は付けず、カレンダーにも共有しない（LLM は runner の /sandbox/llm 越しに呼ぶ）
if ! gcloud iam service-accounts describe "$SANDBOX_SA" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud iam service-accounts create sandbox --project "$PROJECT" \
    --display-name "agent-calendar sandbox (no roles)" --quiet
fi
# 既にある sandbox@ に project の role が付いていたら止める（「sandbox は権限を持たない」が崩れている）
SANDBOX_ROLES=$(gcloud projects get-iam-policy "$PROJECT" --flatten 'bindings[].members' \
  --filter "bindings.members=serviceAccount:${SANDBOX_SA}" --format 'value(bindings.role)')
if [[ -n "$SANDBOX_ROLES" ]]; then
  echo "error: ${SANDBOX_SA} に role が付いている。外してから deploy する:" >&2
  echo "$SANDBOX_ROLES" >&2
  exit 1
fi

# job は runner より先に置く（runner の SANDBOX_JOB が指す先）。入力は実行ごとの override で渡すので env は焼かない
gcloud run jobs deploy "$SANDBOX_JOB_NAME" --project "$PROJECT" --region "$SANDBOX_REGION" --source sandbox \
  --service-account "$SANDBOX_SA" --tasks 1 --max-retries 0 --task-timeout 900s \
  --cpu 1 --memory 512Mi --quiet

# runner が起こせるのはこの job だけ（job 単位の binding。override つきの実行に要る権限）
gcloud run jobs add-iam-policy-binding "$SANDBOX_JOB_NAME" --project "$PROJECT" --region "$SANDBOX_REGION" \
  --member "serviceAccount:${SA}" --role roles/run.jobsExecutorWithOverrides --quiet >/dev/null

gcloud run deploy "$SERVICE" --project "$PROJECT" --region "$REGION" --source . \
  --service-account "$SA" --env-vars-file "$ENV_FILE" \
  --allow-unauthenticated --min-instances 0 --max-instances 2 --concurrency 20 \
  --cpu 1 --memory 512Mi --timeout 300 --quiet

# 古い記録を消す TTL ポリシー（expireAt）。設定済みなら変わらない
for group in fires runs approvals ratelimits sandboxTokens; do
  gcloud firestore fields ttls update expireAt --collection-group="$group" --enable-ttl \
    --project "$PROJECT" --async --quiet >/dev/null
done

if gcloud scheduler jobs describe tick --project "$PROJECT" --location "$REGION" >/dev/null 2>&1; then
  verb=update
else
  verb=create
fi
gcloud scheduler jobs "$verb" http tick --project "$PROJECT" --location "$REGION" \
  --schedule "* * * * *" --time-zone "Asia/Tokyo" --uri "${URL}/tick" --http-method POST \
  --oidc-service-account-email "$SA" --oidc-token-audience "$URL" --attempt-deadline 300s --quiet

echo "$URL"
