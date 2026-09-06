# tamsaek-worker

탐색팩(tamsaekPack) 「AI 글쓰기」용 검색 그라운딩 + AI 이미지 생성 워커.
Cloudflare Workers **무료 플랜**에 단독 배포됩니다 (API 키·DB·외부 서비스 불필요).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/azit4u/tamsaek-worker)

## 기능

- `GET /api/search?q=검색어&engine=all` — 네이버·다음·Bing·뉴스(구글/빙) 4곳 병렬 검색
  - engine 값: `all` `naver` `daum` `bing` `google` (쉼표로 조합 가능)
  - 응답: `{ providers: [ { engine, label, results: [{title, url, snippet}] } ] }`
- `GET|POST /api/image` — Workers AI(flux-1-schnell → SDXL-Lightning → DreamShaper)로
  1024×1024 썸네일 배경 생성, 전부 실패하면 SVG 카드 폴백 (항상 성공)
  - 본문: `{"prompt":"...","width":1024,"height":1024}` → 응답: `{ data_url, provider }`
- 비밀키 인증(선택): `WORKER_SECRET` 등록 시 모든 `/api/*` 요청에 `X-AIBP-Secret` 헤더 검사

## 배포 (원클릭)

위의 **Deploy to Cloudflare** 버튼을 누르면 클라우드플레어 계정으로 바로 배포됩니다.

## 배포 (터미널)

```bash
git clone https://github.com/azit4u/tamsaek-worker.git
cd tamsaek-worker
npx wrangler login     # 처음 한 번, 브라우저로 클라우드플레어 로그인
npx wrangler deploy
```

(선택) 비밀키 — 남이 내 워커를 몰래 못 쓰게 하려면:

```bash
npx wrangler secret put WORKER_SECRET
```

## 워드프레스 연결

배포 결과로 나오는 `https://….workers.dev` 주소를
워드프레스 관리자 → **탐색팩 → AI 글쓰기**의 "검색 Worker 주소" 칸에 넣으면 끝.
비밀키를 등록했다면 "Worker 비밀 키" 칸에 같은 값을 입력합니다.

## 참고

- 공식 검색 API가 아니라 각 검색 사이트의 **공개 결과 페이지를 요청 시점에 읽는 방식**입니다.
  검색 사이트가 화면 구조를 바꾸면 결과가 줄어들 수 있고, 그 경우 `worker.js`의
  파서(`parseNaver` 등)만 고쳐 재배포하면 됩니다.
- Google 일반 웹검색은 서버(공유 IP) 환경을 상시 차단하므로 뉴스 RSS 기반이며,
  그마저 차단되면 Bing 뉴스로 자동 대체됩니다.
- AI 이미지는 Workers AI 무료 일일 할당량을 사용합니다. 소진 시 SVG 카드로 대체됩니다.
- 워커가 응답하지 않아도 탐색팩은 그라운딩 없이 정상적으로 글을 씁니다.

## 파서 단독 시험

`worker.js`는 Node에서도 그대로 import됩니다. 저장해 둔 검색 페이지 HTML로
파서만 따로 시험할 수 있습니다:

```bash
node --input-type=module -e "
import { parseNaver } from './worker.js';
import { readFileSync } from 'fs';
console.log(parseNaver(readFileSync('naver.html','utf-8')).slice(0,3));
"
```
