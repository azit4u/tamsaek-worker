# tamsaek-worker

탐색팩(tamsaekPack) 「AI 글쓰기」용 검색 그라운딩 + AI 이미지 생성 워커.
Cloudflare Workers **무료 플랜**에 각자 자기 계정으로 배포해서 씁니다 (API 키·DB·외부 서비스 불필요).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/azit4u/tamsaek-worker)

## 무엇을 해주나요?

- **검색 조사**: AI가 글을 쓰기 전에 네이버·다음·Bing·뉴스 4곳을 실시간 검색해서 최신 정보를 반영
- **AI 썸네일 배경**: Cloudflare Workers AI(flux)로 1024×1024 이미지를 생성
- 클라우드플레어 무료 요금제 안에서 동작하며, 각자 자기 계정에 배포하므로 사용량도 각자 부담

---

# 설치 안내 (처음 하는 분용)

## 0단계. 준비물

| 준비물 | 비고 |
|---|---|
| 클라우드플레어 계정 | https://cloudflare.com 무료 가입 (카드 등록 불필요) |
| 깃허브 계정 | **방법 A로 할 때만** 필요. 없으면 방법 B로 하면 됨 |

## 1단계. 워커 배포 — 두 가지 방법 중 하나 선택

### 방법 A — 원클릭 배포 (깃허브 계정이 있는 경우, 추천)

1. 이 페이지 맨 위의 **Deploy to Cloudflare** 버튼 클릭
2. 클라우드플레어 로그인
3. "Git account" 단계에서 **New GitHub connection** 클릭 → 깃허브 로그인 → **Authorize** 승인
4. **Create private Git repository** 체크 (내 복사본을 비공개로 보관)
5. Project name은 `tamsaek-worker` 그대로 두고 → **Deploy** 클릭
6. 2~3분 뒤 배포 완료 화면에서 `https://tamsaek-worker.아이디.workers.dev` 형태의 **내 워커 주소**를 메모

### 방법 B — 복사·붙여넣기 배포 (깃허브 없이, 브라우저만으로)

1. 클라우드플레어 대시보드 → **Workers & Pages** → **Create(만들기)**
2. **"Start with Hello World!"** 같은 기본 워커 템플릿 선택 → 이름을 `tamsaek-worker`로 → **Deploy**
3. 배포된 워커 화면에서 **Edit code(코드 편집)** 클릭
4. 새 탭에서 이 주소를 열어 코드 전체 복사:
   **https://raw.githubusercontent.com/azit4u/tamsaek-worker/main/worker.js**
5. 편집기의 기존 예제 코드를 전체 선택(Ctrl+A / ⌘+A)해서 지우고 → 복사한 코드 붙여넣기 → **Deploy**
6. 워커 주소(`https://tamsaek-worker.아이디.workers.dev`)를 메모

## 2단계. AI 이미지 켜기 (Workers AI 바인딩)

AI 썸네일 배경 생성을 쓰려면 필요합니다. (검색만 쓸 거면 건너뛰어도 됨)

1. 클라우드플레어 대시보드 → 내 워커(tamsaek-worker) → **Settings** → **Bindings**(또는 Variables and Secrets 옆 Bindings 메뉴)
2. **Add** → **Workers AI** 선택 → Variable name을 `AI` 로 입력 → 저장/Deploy

확인: 브라우저에서 `https://내워커주소/api/image?prompt=test` 를 열었을 때
- `"provider":"@cf/black-forest-labs/flux-1-schnell"` 이 보이면 성공
- `"provider":"svg-fallback"` 이면 바인딩이 아직 안 붙은 것 → 위 과정 다시 확인

## 3단계. 비밀키 걸기 (남이 내 워커 못 쓰게 — 강력 추천)

주소만 알면 누구나 내 워커(내 무료 한도)를 쓸 수 있으므로 비밀키를 겁니다.

1. 아무 긴 문자열을 하나 정합니다 (예: 키보드를 마구 눌러 만든 30자 이상. 이게 내 비밀키)
2. 클라우드플레어 대시보드 → 내 워커 → **Settings** → **Variables and Secrets** → **Add**
3. Type: **Secret** / Variable name: `WORKER_SECRET` / Value: 위에서 정한 문자열 → **Deploy**
4. 이 문자열은 4단계에서 워드프레스에도 넣어야 하니 잠시 복사해 둡니다

확인: 브라우저에서 `https://내워커주소/api/search?q=test` 를 열었을 때 **"인증 실패"(401)** 가 나오면 잠금 성공입니다. (내 워드프레스는 키를 알고 있으니 정상 작동)

## 4단계. 워드프레스(탐색팩)에 연결

워드프레스 관리자 → **탐색팩 → AI 글쓰기**:

1. **검색 Worker 주소** 칸: 1단계에서 메모한 `https://tamsaek-worker.아이디.workers.dev` 입력
2. **Worker 비밀 키** 칸: 3단계에서 정한 문자열 입력
3. 저장

## 5단계. 최종 확인

- 새 글 쓰기 → AI 글쓰기 메타박스 → 시사성 있는 주제로 글 생성 → 최신 정보가 반영되는지 확인
- AI 썸네일 탭 → 그림 주제 입력 → **AI 배경 생성** → 실제 그림이 나오는지 확인

> 참고: 글 생성 자체에는 **제미나이(Gemini) API 키**도 필요합니다.
> https://aistudio.google.com/apikey 에서 구글 계정으로 무료 발급 → 탐색팩 AI 글쓰기 설정의 API 키 칸에 등록.
> 키는 여러 개 등록해두면 한도 초과 시 자동으로 다음 키로 넘어갑니다.

---

## 자주 묻는 것

**Q. 돈이 드나요?**
클라우드플레어 무료 플랜으로 충분합니다 (검색 하루 10만 요청, AI 이미지는 무료 일일 할당량). 개인 블로그 용도로는 한도 걱정이 거의 없습니다.

**Q. 다른 사람 워커 주소를 같이 쓰면 안 되나요?**
되긴 하지만 그 사람의 무료 한도를 나눠 쓰게 되고, 비밀키도 공유해야 합니다. 각자 배포하는 게 정답입니다.

**Q. 검색 결과가 갑자기 줄었어요.**
검색 사이트가 화면 구조를 바꾸면 생길 수 있습니다. 이 저장소가 업데이트되면 다시 배포(방법 A: 버튼 다시 클릭 / 방법 B: 새 코드 복사·붙여넣기)하면 됩니다.

---

## 기술 정보 (개발자용)

- `GET /api/search?q=검색어&engine=all` — engine: `all` `naver` `daum` `bing` `google` (쉼표 조합 가능)
  - 응답: `{ providers: [ { engine, label, results: [{title, url, snippet}] } ] }`
- `GET|POST /api/image` — body `{"prompt":"...","width":1024,"height":1024}` → `{ data_url, provider }`
  - 모델 체인: flux-1-schnell → SDXL-Lightning → DreamShaper → SVG 카드 폴백
- 비밀키: `WORKER_SECRET` 등록 시 모든 `/api/*` 요청에 `X-AIBP-Secret` 헤더 검사
- 터미널 배포: `npx wrangler login` 후 `npx wrangler deploy`, 비밀키는 `npx wrangler secret put WORKER_SECRET`
- `worker.js`는 Node에서도 그대로 import 가능 — 저장한 검색 페이지 HTML로 파서(`parseNaver` 등)만 단독 시험 가능
