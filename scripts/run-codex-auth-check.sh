#!/usr/bin/env bash
set -euo pipefail
umask 077
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"
mkdir -p logs
log_path="logs/codex-auth-check-$(TZ=Asia/Seoul date +%Y%m%d-%H%M%S).log"
if [ -e data/.operating-maintenance ]; then
  node scripts/check-operating-maintenance.js --path data/.operating-maintenance >>"$log_path" 2>&1
  exit 0
fi
exec 9>data/.codex-auth-check.lock
flock -n 9 || exit 0
if node scripts/check-codex-auth.js >>"$log_path" 2>&1; then exit 0; fi
if grep -Fqx 'OJEOMMWO_CODEX_AUTH_CHECK_FAILURE=authentication-required' "$log_path"; then
  detail="서버 Codex 로그인 세션이 거부되었습니다. 자동 재시도 대상이 아니며 서버 전용 재인증이 필요합니다. 기존 자격 증명과 운영 데이터는 보존되었습니다."
elif grep -Fqx 'OJEOMMWO_CODEX_AUTH_CHECK_FAILURE=authentication-persistence-failed' "$log_path"; then
  detail="Codex 갱신 자격 증명을 안전하게 보존하지 못했습니다. 보호 파일 권한과 동시 변경 여부를 점검해야 합니다. 기존 자격 증명과 운영 데이터는 보존되었습니다."
elif grep -Fqx 'OJEOMMWO_CODEX_AUTH_CHECK_FAILURE=model-configuration-required' "$log_path"; then
  detail="서버 Codex 모델 또는 CLI 설정이 공급자와 호환되지 않습니다. 배포된 모델 핀과 CLI 버전을 점검해야 합니다."
else
  detail="서버 Codex 실호출 실패. 일시적 공급자 장애, 네트워크 또는 실행 환경 상태를 점검해야 합니다."
fi
node scripts/send-operations-alert.js --job "모델 인증 점검" \
  --detail "$detail 로그: $project_root/$log_path" >>"$log_path" 2>&1 || true
exit 1
