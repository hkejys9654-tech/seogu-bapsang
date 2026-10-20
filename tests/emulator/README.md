# 격리된 동시 예약 시험

운영 앱의 예약·취소 함수를 추출하여 각 가상 사용자별 Firebase SDK 인스턴스에서 실행합니다. 실제 직원 예약과 분리되며 운영 Firebase 프로젝트에는 쓰지 않습니다.

## 실행

Node.js와 Java 17 이상을 준비하고 저장소 루트에서 실행합니다.

```sh
npm install --prefix /tmp/bapsang-load-env --no-audit --no-fund firebase-tools@14.12.1 firebase@10.12.5
NODE_PATH=/tmp/bapsang-load-env/node_modules \
  /tmp/bapsang-load-env/node_modules/.bin/firebase emulators:exec \
  --only firestore --project demo-bapsang-load \
  --config tests/emulator/firebase.json \
  'node tests/load-reservations.cjs --output /tmp/bapsang-load-results.json'
```

한 시나리오만 선택하려면 자식 명령에 `--scenario single-50`을 추가합니다. 여러 시나리오는 쉼표로 구분합니다. 기준 HTML은 `BAPSANG_HTML=/absolute/path/index.html`로 고정할 수 있습니다. 일반 회귀시험은 `node --test tests/*.test.cjs`입니다.

## 측정과 한계

- 50·100·400명이 같은 회차에 동시에 예약하거나 400명이 5개 회차로 분산하는 상황을 검사합니다.
- 단체 예약, 같은 직원의 여러 기기 예약, 중복 취소, 통신/권한 오류도 검사합니다.
- 완료·마감·오류 건수, 지연시간, SDK 트랜잭션 시도 횟수와 정원·대기번호·좌석 집계 일치를 JSON으로 기록합니다.
- SDK 기본 재시도를 그대로 사용합니다. 시험 코드가 요청을 직렬화하거나 실패를 숨기는 추가 재시도를 하지 않습니다.
- 시나리오마다 **이 데모 프로젝트의 에뮬레이터 데이터만** 초기화합니다. 실행기는 로컬 주소와 `demo-bapsang-load` 프로젝트를 강제합니다.
- 같은 에뮬레이터·프로젝트에서 시험 프로세스를 둘 이상 동시에 실행하지 마세요. 시나리오는 한 프로세스에서 순차 실행하고, 시나리오 안의 예약 요청을 동시에 보냅니다.
- 이 폴더의 허용 규칙은 **로컬 시험 전용**입니다. 실제 프로젝트에 배포하지 마세요. 운영 보안 규칙을 검증하는 시험이 아닙니다.
- 에뮬레이터는 운영 Firestore의 트랜잭션 동작과 지연·한도를 모두 재현하지 않습니다. 결과는 실제 서버 수용 인원이나 모바일 기기 성능 보장이 아닙니다.

Firebase 공식 문서: https://firebase.google.com/docs/emulator-suite/connect_firestore#how_the_cloud_firestore_emulator_differs_from_production
