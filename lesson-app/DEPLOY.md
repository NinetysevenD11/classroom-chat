# 클라우드 배포 (Docker + Fly.io)

앱은 **Docker**로 빌드되며, **Fly.io** 예시 설정(`fly.toml`)이 포함되어 있습니다. PDF 변환을 위해 이미지 안에 Chromium(Playwright)이 설치됩니다.

## 사전 준비

- [Fly CLI](https://fly.io/docs/hands-on/install-flyctl/) 설치 후 `fly auth login`
- `fly.toml`의 `app = "lesson-app"`을 **전역에서 유일한 앱 이름**으로 바꾸세요 (예: `lesson-app-yourname`).

## 영구 디스크

회원·자료 라이브러리·생성 PDF는 `LESSON_PERSIST_DIR=/data`에 저장됩니다. Fly에서는 볼륨을 만든 뒤 배포합니다.

```bash
# 앱과 같은 리전 사용 (fly.toml의 primary_region, 예: nrt)
fly volumes create lesson_data --region nrt --size 3
```

볼륨 이름 `lesson_data`는 `fly.toml`의 `[[mounts]]` `source`와 같아야 합니다.

## 시크릿

```bash
fly secrets set STORAGE_SECRET="$(openssl rand -hex 32)"
# 선택: 고정 관리자 계정 (로컬과 동일 형식)
# fly secrets set LESSON_APP_USERS='admin:비밀번호해시'
```

API 키는 UI에서 로그인 후 저장하는 방식을 그대로 쓰면 됩니다. 빌드 시 `.env`는 이미지에 넣지 마세요.

## 배포

프로젝트 루트에서:

```bash
fly launch --no-deploy   # 이미 앱이 있으면 생략 가능
fly deploy
```

배포 후 `fly apps open` 또는 대시보드에 표시된 `https://<앱이름>.fly.dev` 로 접속합니다.

## 로컬에서 Docker만 검증

```bash
docker build -t lesson-app .
docker run --rm -p 8080:8080 -e STORAGE_SECRET=test-secret lesson-app
```

영구 저장을 테스트하려면 `-v lesson_data:/data` 를 추가하세요.

## 다른 플랫폼 (Railway, Render, Cloud Run)

- 컨테이너에 동일한 Dockerfile 사용
- 환경 변수: `PORT`(플랫폼이 주입), `HOST=0.0.0.0`, `STORAGE_SECRET`, 필요 시 `LESSON_PERSIST_DIR`와 이에 맞는 디스크/볼륨 마운트
- Railway는 `RAILWAY_ENVIRONMENT`, Cloud Run은 `K_SERVICE`가 잡혀 **지정된 `PORT`만** 바인딩합니다
