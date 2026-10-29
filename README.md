# PDF Reflow

PDF 본문을 화면에 맞게 다시 줄바꿈하는 브라우저 앱입니다. 수식·그림·표는 원문 영역 이미지로 보존하며, 읽기본·원문 대조본·검증 보고서를 내려받을 수 있습니다. PDF는 서버로 업로드하지 않습니다.

## 개발 시작

저장소를 clone한 뒤 Windows PowerShell에서 실행합니다. 명령 프롬프트에서는 `run setup`처럼 입력합니다.

```powershell
.\run setup
.\run dev
```

`setup`은 필요한 Node.js 24, 잠금 파일 기준 의존성, Chromium과 테스트 자료를 준비하고 타입·린트·단위 시험·빌드·브라우저 시험까지 실행합니다. Windows에서 Node.js 24가 없으면 저장소의 `.tools/node/`에 설치합니다. 전역 Node.js 설정을 바꾸지 않습니다.

macOS/Linux에서는 Node.js 24를 설치한 뒤 `node scripts/run.mjs setup`을 사용합니다. 나머지 명령도 `node scripts/run.mjs <명령>` 형태로 실행할 수 있습니다.

| 명령                              | 용도                                             |
| --------------------------------- | ------------------------------------------------ |
| `run dev`                         | 개발 서버                                        |
| `run test`                        | 타입·린트·단위 시험·빌드·브라우저 시험 전체 실행 |
| `run test-unit` / `run test-e2e`  | 단위 시험 / 브라우저 시험                        |
| `run check`                       | 타입·린트·단위 시험·빌드 검사                    |
| `run build` / `run preview`       | 배포 빌드 / 빌드 미리보기                        |
| `run lint` / `run typecheck`      | 개별 코드 검사                                   |
| `run format` / `run format-check` | 포맷 수정 / 검사                                 |
| `run clean-repo`                  | 생성물·테스트 결과·캐시 삭제                     |
| `run help`                        | 명령 안내                                        |

테스트 소스는 `tests/`에 유지합니다. 테스트용 PDF·다운로드·결과·브라우저·빌드는 모두 `.cache/`에 생성합니다. `run clean-repo`는 이 임시 폴더와 도구 캐시를 삭제하고 소스·의존성·개발용 Node.js를 유지합니다. 이후 개발·테스트 명령이 필요한 생성물을 다시 준비합니다. 배포 결과는 `.cache/dist/`입니다.

## GitHub Pages

1. 저장소 **Settings → Pages → Source**를 **GitHub Actions**로 설정합니다.
2. `main`에 push하거나 Actions에서 배포 워크플로를 직접 실행합니다.
3. 동일한 `setup` 검사와 브라우저 시험이 통과하면 Pages에 배포됩니다.

저장소 이름에 맞는 경로를 자동으로 사용합니다. 사용자 도메인은 Actions 변수 `APP_BASE`를 `/`로 설정하세요. 로컬 하위 경로 확인:

```powershell
$env:APP_BASE = '/pdf-reformatter/'
.\run preview
Remove-Item Env:APP_BASE
```

## 사용 범위

- 텍스트 PDF를 대상으로 합니다. OCR은 제공하지 않으며, 보존 이미지의 글자는 검색·복사되지 않습니다.
- 복잡한 다단 문서와 수식은 원문과 대조하세요. 검증 보고서는 의미나 시각적 일치 전체를 보증하지 않습니다.
- 원본의 암호·권한·서명·양식·링크 동작은 변환본으로 이전하지 않습니다. 영역 자르기는 보안 삭제 기능이 아닙니다.
- Fold7 기본값은 492 × 546 pt, 본문 13.2 pt입니다. 색상·상하 여백은 임시값이며 실제 기기와 승인 원문 대조는 필요합니다.
- 작업 파일에는 추출 본문과 보정이 포함됩니다. 원본 PDF 바이트는 저장하지 않습니다. 앱 자산을 받는 접속은 호스팅 제공자의 로그에 남을 수 있습니다.

외부 구성 요소의 라이선스와 글꼴 출처는 [법적 고지](legal/THIRD_PARTY_NOTICES.md)에 있습니다. 앱 코드의 공개 라이선스는 아직 지정하지 않았습니다.
