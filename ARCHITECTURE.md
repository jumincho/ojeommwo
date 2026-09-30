# 현재 구조

제품 v2 / 2.0.0. 서버의 통합 프로젝트가 기준이며 관측소는 `observatory/` 하위 모듈이다.

```text
host pororo cron -> docker ojeommwo -> scripts/*.sh -> Slack cache 발송 / 후보 재검증
Slack Socket Mode -> interaction-listener -> 모달/설문/커피 -> 스키마 검증 + JSON store
실제 식사 입력 -> trash 검사 + 별칭 -> Luna 웹 검색 -> 지점/메뉴 본문 검증 -> 정규 기록
후보 탐색 -> Luna 웹 검색/의미 분류 -> 독립 HTML 근거 검증 -> active + catalog
JSON store -> Beta 선호 계산 + cooldown + 다양성 최적화 -> 3개 추천
JSON store -> 공개 집계 export -> 인증된 snapshot 전송 -> Sites Worker R2 -> 관측소
server source + static out + 7개 store -> Windows OFF 비상 사본
```

## 파일 책임

| 영역 | 파일/폴더 | 책임 |
|---|---|---|
| 계약 | config.js, version.js, categories.js, text.js | 고정 설정, 릴리즈, 카테고리/음식 형식, 식당·메뉴 identity |
| 의미 분류 | category-arbitration.js, prompts/ | Luna 신뢰 선언·구조 검증·identity-bound stamp·애매한 분류 판정 |
| 후보 | candidate-research.js, candidate-evidence.js, verified-candidates.js | 계획, TTL, 근거 페이지, 가격·배달·좌표·폐점, reserve와 저장 |
| 추천 | recommender.js, choice-diversity.js, cooldown.js, taste-profile.js | 확률적 탐색을 섞은 선호 점수, 엄격한 재추천 제한, 최적의 다양한 3개 조합 |
| Slack | meal-service.js, slack.js, message.js, dm-preview.js | 보호 대상, 메시지, 유한 재시도, outbox, 테스트 분리 |
| 입력 | interaction-*.js, meal-feedback.js, meal-normalization.js, meal-event-normalizer.js | 즉시 ack, 모달, 무효 입력 차단, 정규화, 동시성 |
| 운영 데이터 | storage.js, operating-*.js, secure-file.js, time-integrity.js | 7개 store 검증, 잠금·원자적 저장, snapshot·merge·시간 검증 |
| 외부 통신 | http-transport.js, weather.js, codex-cli.js | 고정 수정 통신, 국내 날씨, 비특권/제한된 모델 작업 |
| 점검/운영 | health.js, scripts/, test/ | 운영 health, 스케줄 fence, 배포·동기화·비상 모드, 회귀 검사 |
| 사이트 | observatory/app, worker, build, scripts, tests | 브라우저, CSP/R2, 서버 빌드, 공개 projection와 검사 |

## 신뢰 경계

Luna는 웹에서 신원을 찾고 분류를 판단한다. 출력은 신뢰하지 않는 구조화된 주장으로 받아, 스키마·거리·canonical identity·허용 웹 주소·실제 본문·가격 결합·배달 운영·TTL·음식 다양성 검증을 통과시킨다. 모델은 운영 DB를 직접 수정하지 않는다. Codex 작업은 비특권 일회성 환경이며 인증 source와 파일/환경비밀을 웹 입력에서 분리한다.

카테고리 판정은 실제 음식 형태를 보호한다. 피자의 불고기, 카레의 삼겹살 같은 재료 키워드가 형식을 뒤집지 않는다. 합성 메뉴 등 충돌하는 구조적 형태는 검증된 Luna 의미 판정에 맡긴다. 이 계약을 입력·검색·기존 DB·Slack·관측소가 함께 사용한다.

## 점수와 신호

선호는 Beta 사전 (3,3)에서 시작한다. 실제 식사와 추천 후보 설문을 동시에 반영하되 설문 0.9, 실제 1.0의 가중치와 180일 반감기를 적용한다. 정확한 메뉴/식당 일치는 강하고 카테고리 전이는 약하다. 같은 응답자의 하루 중복과 반복을 제한한다. 3점/미선택은 부정으로 해석하지 않는다.

추천 score는 검증된 source 우선, 배달/가격 근거 신뢰, taste, 작은 category 동점 처리, 첫 식당 0.5점, 원거리 likely 배달 패널티를 사용한다. 82% posterior mean + 18% Beta sample이므로 늘 최고 선호만 선택하지 않는다. restaurant/menu cooldown을 완화하지 않고 카테고리·식당·메뉴·주재료가 겹치지 않는 조합의 합계 점수를 최적화한다.

## 신선도와 용량

가격 근거 7일, 배달 및 HTML 검증 3일이 기본 TTL이며 갱신 때 active 및 순환 catalog 페이지를 다시 가져온다. 실제 다음 발송과 reserve horizon까지 유효한지 확인한다. 폐점/지점 불일치는 후보/과거 fallback에서 제거하고 백업에도 반영한다. 일시 장애는 아직 유효한 last-known-good만 유지한다. active 12와 제한된 catalog 및 출력/HTML/파일 크기 상한으로 메모리를 제한한다.

JSON은 잠금 token·스키마 검증·제한된 크기·temp+fsync+rename으로 저장한다. 손상된 primary의 검증된 backup을 읽을 수 있지만 폐점 후보를 복구시키지 않는다. 동시 입력은 최신 자료를 다시 읽어 반영한다. 운영 발송은 안정된 client_msg_id와 outbox에 기록하고 전송 결과 불명확 시 임의 재발송하지 않는다.

## 배포와 비상

Sites는 공개 정적 자산/Worker와 R2 집계만 맡는다. 원본 DB는 pororo에 있고 10분 export가 algorithm fingerprint와 함께 전달된다. 업로드는 authenticated header chunks, bounded decompression, SHA-256 및 R2 조건부 write다. 동일 commit 재시도는 receipt를 돌려주며 더 새 snapshot을 늦은 요청이 덮지 못한다.

Windows 비상 사본은 source seal(봇·lock·정적 fixture·관측소 source)과 7개 store 해시를 검증한다. 평소 OFF, 서버가 정상일 때 활성화 불가, explicit lease 및 서버 복구 감지 정지, 종료 후 동시성에 안전한 merge를 사용한다. 소스 버전 같음과 DB 최신성은 별도 조건이다. 자동 offsite 백업은 없다.
