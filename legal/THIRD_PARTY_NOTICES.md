# Third-party notices

앱 코드의 라이선스 선택과 아래 구성 요소의 라이선스는 별개입니다. 설치 버전은 `package-lock.json`으로 고정합니다. 런타임 라이브러리의 라이선스 원문과 메타데이터는 빌드 시 `.cache/public/licenses/`에 복사되어 배포 결과의 `licenses/`에도 포함됩니다.

| 구성 요소                 | 고정 버전                             | 라이선스                          | 출처                                                     |
| ------------------------- | ------------------------------------- | --------------------------------- | -------------------------------------------------------- |
| React / React DOM         | 19.3.1                                | MIT                               | https://github.com/facebook/react                        |
| PDF.js / pdfjs-dist       | 6.4.299                               | Apache-2.0                        | https://github.com/mozilla/pdf.js                        |
| pdf-lib                   | 1.17.1                                | MIT                               | https://github.com/Hopding/pdf-lib                       |
| @pdf-lib/fontkit          | 1.1.1                                 | MIT                               | https://github.com/Hopding/fontkit                       |
| Lucide React              | 1.63.0                                | ISC; 일부 Feather 유래 아이콘 MIT | https://github.com/lucide-icons/lucide                   |
| Noto Serif Regular / Bold | 포함 파일 기준                        | SIL OFL 1.1                       | https://github.com/notofonts/noto-fonts                  |
| Noto Sans Regular         | 포함 파일 기준                        | SIL OFL 1.1                       | https://github.com/notofonts/noto-fonts                  |
| Noto Sans KR Regular      | 2.004-H2 / weight 400 static instance | SIL OFL 1.1                       | https://github.com/google/fonts/tree/main/ofl/notosanskr |

라틴 Noto 글꼴은 원본 파일을 포함합니다. 한국어 Noto Sans KR은 Google Fonts의 가변 TTF를 fontTools 4.55.0으로 weight 400의 정적 TTF로 만든 파생 파일입니다. fontkit subset 호환을 위해 `GSUB/GPOS/GDEF/BASE`·세로 조판 메트릭을 제거하고 `glyf` 패딩을 4로 맞췄습니다. 글리프 윤곽은 유지하지만 복잡한 문자 조형과 세로 조판은 지원하지 않습니다. 재현 스크립트는 `scripts/prepare-korean-font.py`이며 입력 원본의 SHA-256을 검사합니다. 원본의 Reserved Font Name은 `Source`이며 파생 파일은 이 이름을 사용하지 않습니다. 라틴 글꼴 라이선스는 `public/fonts/OFL-Noto.txt`, 한국어 글꼴 라이선스는 `public/fonts/OFL-NotoKR.txt`에 있습니다. 문서에 포함되는 글꼴 subset은 PDF 삽입을 위한 것이며 원본 글꼴을 별도 판매하지 않습니다. 배포 글꼴 바이트의 해시와 파생 정보는 `legal/fonts.json`에 기록합니다.

PDF.js의 CMap·standard_fonts·WASM 디렉터리는 설치된 패키지에서 복사합니다. 이 디렉터리의 개별 라이선스 파일도 함께 배포합니다. PDF.js는 이미지 디코더 등 별도 고지가 있는 코드를 포함할 수 있으므로 패키지의 라이선스·번들 고지를 유지합니다.

`@pdf-lib/fontkit` npm 배포본은 라이선스를 MIT로 선언하며 README에서도 MIT를 명시합니다. 별도 LICENSE 파일이 배포본에 없으므로 배포 고지에는 해당 메타데이터·README와 번들 안의 저작권/라이선스 주석을 보존합니다. Node 호환 코드 및 Brotli 등 번들된 구성 요소의 고지는 생성된 `licenses/pdf-lib-fontkit-bundled-notices.txt`에서 확인할 수 있습니다.

간접 런타임 의존성(`pako`, `tslib`, `scheduler`, `@pdf-lib/standard-fonts`, `@pdf-lib/upng` 등)의 설치 메타데이터와 존재하는 라이선스 원문 역시 `licenses/`에 포함합니다. 빌드 도구는 웹앱 런타임에 포함하지 않습니다. 의존성 갱신 시 원문과 고지를 다시 확인해야 합니다.

테스트 예제는 이 프로젝트에서 생성한 합성 내용입니다. 사용자 PDF, 승인된 비공개 기준 문서, 권리 미확인 외부 자료는 배포 자산에 포함하지 않습니다.
