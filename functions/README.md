# 서구밥상 호출 알림 서버

직원이 입장표를 닫은 뒤에도 관리자의 입장 호출을 전달하는 Firebase Cloud Functions입니다. 관리자의 데모 인증 방식은 변경하지 않습니다.

## 배포 연결

1. 기존 Firebase 프로젝트의 Cloud Messaging 웹 푸시 인증서에서 **공개 키**를 확인합니다.
2. `functions/.env.example`을 `functions/.env.<프로젝트-ID>`로 복사하고 `WEB_PUSH_VAPID_KEY`에 공개 키를 설정합니다. 비공개 키나 서비스 계정 파일은 저장소에 넣지 않습니다.
3. 저장소 최상위에서 기존 Firebase 프로젝트를 명시하여 배포합니다.

   ```sh
   npm --prefix functions ci
   firebase deploy --only functions --project <프로젝트-ID>
   ```

4. `getPushConfig`가 `{enabled:true,vapidKey:"..."}`를 반환하는지 확인합니다. 직원의 실제 휴대폰에서 알림을 허용한 뒤 앱을 닫고 관리자가 호출하여 실기기 수신을 확인해야 연결 완료로 판단합니다.

서버 런타임은 Node.js 22입니다. Cloud Functions 배포에 필요한 프로젝트 권한·결제 설정과 FCM API가 활성화되어 있어야 합니다. 이 저장소의 코드만 GitHub Pages에 게시해서는 Firebase 함수가 배포되지 않습니다.

## 연결 규격

모든 함수의 리전은 `asia-northeast3`입니다.

| 함수 | 요청 | 응답 |
|---|---|---|
| `getPushConfig` | GET | `{enabled:boolean,vapidKey:string}` |
| `registerPushToken` | POST `{token,emp}` | `{ok:true}` |
| `unregisterPushToken` | POST `{token,emp}` | `{ok:true}` |

`emp`는 기존 앱과 동일한 4자리 행정번호입니다. 직원 이름·부서는 등록하지 않습니다. 한 직원의 여러 휴대폰/브라우저를 각각 보관하며, 연결을 끄면 해당 기기만 비활성화합니다. 기존 직원별 토큰도 읽되 동일 기기의 새 소유자 및 비활성 상태를 우선합니다.

현재 데모는 행정번호 입력 방식이며 별도의 직원 본인 인증을 추가하지 않았습니다. 이 기능이 관리자·직원 인증의 보안 개선을 의미하지 않습니다.

## 발송 조건

- 예약이 새 호출로 변경되고, 현재 DB에서도 오늘(한국 시간) 예약·호출 상태와 호출 묶음이 일치할 때만 전송합니다.
- 호출 시점부터 120초가 지난 메시지는 재발송하지 않습니다. FCM에 남은 유효시간도 최대 120초로 설정하며, 수신 측에서도 `expiresAt`을 확인합니다.
- 데이터 메시지의 `emp`, `reservationId`, `callBatchId`, `expiresAt`은 문자열입니다. `title`, `body`, `url`도 함께 전달합니다. 실제 알림 표시는 서비스 워커가 담당합니다.
- 정상 발송된 기기는 최근 호출 식별자 8개를 기록하여 재시도에서 제외합니다. 일반적인 페이지 재접속에서도 유지하며, 같은 기기의 직원이 바뀌면 초기화합니다. FCM이 수락했다는 기록이며 휴대폰 수신을 보장하는 기록은 아닙니다.
- 명확한 토큰 만료/무효 오류만 해당 기기를 비활성화합니다. 일시 장애는 유효한 기기 등록을 유지하고 짧은 유효시간 안에서 재시도합니다.
- 데이터 메시지 클릭은 서비스 워커에서 처리합니다. 데이터 메시지가 지원하지 않는 `fcmOptions.link`를 붙이지 않습니다.

## 확인

저장소 최상위에서 `node --test tests/push-backend.test.cjs`를 실행합니다. 이 테스트는 Firebase 호출을 대체하므로 실제 DB를 수정하거나 실제 알림을 발송하지 않습니다. 실기기 알림 수신 시험은 별도로 필요합니다.
