# 관측소 v3 보안 경계

공개 사이트는 검증·정제된 스냅샷만 제공한다. 원본 Slack 사용자 ID, 자유 입력 원문, OAuth·Slack·공공 API 키와 운영 원본 DB를 포함하지 않는다. R2 게시에는 보호 토큰과 요청 크기·시각·스키마·SHA-256 검사를 적용한다. 오래되거나 충돌한 게시를 최신 데이터로 승격하지 않는다.

CSP는 실제 빌드의 스크립트 해시와 동적 import/WebGL 동작을 함께 확인한다. HTTP 200만으로 프런트 정상 동작을 판정하지 않는다. 외부 데이터는 HTML 코드로 실행하지 않는다. 의존성 lock과 보안 override를 보존하고 `corepack pnpm audit` 및 `corepack pnpm audit --prod`, lint·typecheck·테스트·빌드를 수행한다.

image-size는 공식 수정 버전 2.0.3을 고정한다. JXL/HEIF의 GHSA-5p2g-fcmc-qvqq와 ICNS의 GHSA-w3rx-r6r6-pgpr에 대응하던 2.0.2 자체 patch와 audit ignore 두 항목은 제거했다. CJS/ESM 모두 악성 길이 이미지 입력이 3초 제한 안에 종료되는지와 정상 PNG/ICNS/HEIF 크기를 읽는지 회귀로 확인한다. 감사 예외 없이 전체 의존성 audit이 알려진 취약점 0이어야 한다.

컨테이너 `/root` 접근을 무작정 넓히지 않는다. 호스트 bind mount의 상위 `/home/ojeommwo/docker1/root`는 root:ojeommwo 0710, 프로젝트 0750, 관측소의 호스트 소유권을 유지한다. 운영 data 0700, 비밀과 저장소 0600을 유지한다. 호스트 cron의 실제 계정으로 게시와 health를 실행하여 Permission Denied 회귀를 검사한다.

Sites의 소유권·공개 범위를 유지하고 공개 포트나 trycloudflare 임시 터널을 다시 만들지 않는다. 최종 검증 결과와 외부 의존성의 한계는 상위 `QUALITY_REPORT.md`를 따른다.
