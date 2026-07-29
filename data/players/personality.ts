/**
 * personality — 선수 성격 큐레이션 (players v2.1, 에픽 p2-data / PRD-v3 P2-D7).
 *
 * players.v2 (172명) 위에 **additive** 로 `personality` 필드를 부여한다. v2 로스터(roster.ts)·
 * 능력치는 **무변경** — 이 파일은 이름→성격 매핑만 추가하고, generate.ts 가 players.v2.1.json 을
 * 파생할 때 이름으로 조회해 붙인다. (roster.ts 를 건드리지 않아 players.v2.json 바이트 동일 보장.)
 *
 * 성격 4종(P2-D7, ERD-v2 players.personality CHECK 와 동일 enum):
 *   FIERY(불꽃)     — 다혈질·투쟁적 리더, 감정 표출, 강한 지시에 과반응. 강한 압박/공격 지시에 잘 반응하나
 *                     질책이 과하면 카드/충돌. (예: Maradona, Rüdiger, Casemiro, Gavi, Lee Kang-in)
 *   CALM(침착)      — 냉정·안정, 압박 상황에서 흔들리지 않음. 기본값(과반). 지시에 꾸준히 반응.
 *                     (예: Kroos, Modrić, van Dijk, Son Heung-min, Ki Sung-yueng)
 *   GLASS(유리멘탈) — 자신감 의존·기복, 질책성 프롬프트에 위축(mentalModifier↓), 슬럼프·프레셔 취약.
 *                     주로 폼 편차 큰 선수·어린 프로스펙트. (예: Rashford, Havertz, Arda Güler, Park Chu-young)
 *   AMBITIOUS(야심가)— 승부욕·자기주도, 상위 이동/기록 지향. 공격 지시 선호, 도전적 목표에 동기부여.
 *                     (예: Ronaldo Nazário, Mbappé, Haaland, Park Ji-sung)
 *
 * 큐레이션 기준(문서: docs/plan-v2/grade-mapping-v2.md §8 personality):
 *   선수의 실제 이미지(기질·커리어 서사·미디어 페르소나)를 반영해 배정. 절대 등급이 아니라
 *   "감독 관계 반응 유형"의 층위다. 어린 프로스펙트/폼 기복형은 GLASS, 커리어 야망형은 AMBITIOUS,
 *   투쟁적 리더는 FIERY, 그 외 안정형은 CALM(기본).
 *
 * 목표 분포(PRD-v3 P2-D7 / LLD-p2-data §1): 대략 FIERY 25% / CALM 40% / GLASS 15% / AMBITIOUS 20%.
 *   실제(172명): FIERY 41(23.8%) / CALM 69(40.1%) / GLASS 25(14.5%) / AMBITIOUS 37(21.5%).
 *   #207 신규 8종 포함(180명): FIERY 45(25.0%) / CALM 71(39.4%) / GLASS 25(13.9%) / AMBITIOUS 39(21.7%).
 *   #256 신규 2종 포함(182명): FIERY 45(24.7%) / CALM 73(40.1%) / GLASS 25(13.7%) / AMBITIOUS 39(21.4%).
 *   (data.test.ts 가 밴드로 검증 — enum·분포·전원 매핑·CALM 최다.)
 */
import type { Personality } from "./generate";

/** 이름(roster.ts 와 정확히 일치)→성격. **182명 전원**. data.test.ts 가 ROSTER 와 전단사(bijection) 검증. */
export const PERSONALITY: Record<string, Personality> = {
  // ── LEGEND (12) ──────────────────────────────────────────────────
  "Lev Yashin": "CALM",
  "Franz Beckenbauer": "CALM",
  "Paolo Maldini": "CALM",
  "Franco Baresi": "FIERY",
  "Diego Maradona": "FIERY",
  "Zinedine Zidane": "FIERY",
  "Michel Platini": "CALM",
  "Lothar Matthäus": "AMBITIOUS",
  "Pelé": "AMBITIOUS",
  "Ronaldo Nazário": "AMBITIOUS",
  "Johan Cruyff": "AMBITIOUS",
  "Marco van Basten": "CALM",

  // ── DIA (25) ─────────────────────────────────────────────────────
  "Alisson": "CALM",
  "Thibaut Courtois": "AMBITIOUS",
  "Virgil van Dijk": "CALM",
  "Rúben Dias": "FIERY",
  "Achraf Hakimi": "FIERY",
  "Alphonso Davies": "AMBITIOUS",
  "Antonio Rüdiger": "FIERY",
  "William Saliba": "CALM",
  "Theo Hernández": "FIERY",
  "Kim Min-jae": "FIERY",
  "Rodri": "CALM",
  "Kevin De Bruyne": "FIERY",
  "Jude Bellingham": "FIERY",
  "Federico Valverde": "FIERY",
  "Luka Modrić": "CALM",
  "Toni Kroos": "CALM",
  "Martin Ødegaard": "CALM",
  "Pedri": "GLASS",
  "Erling Haaland": "AMBITIOUS",
  "Kylian Mbappé": "AMBITIOUS",
  "Vinícius Júnior": "FIERY",
  "Harry Kane": "AMBITIOUS",
  "Mohamed Salah": "AMBITIOUS",
  "Lautaro Martínez": "FIERY",
  "Son Heung-min": "CALM",

  // ── GOLD (36, 인터내셔널) ────────────────────────────────────────
  "Ederson": "CALM",
  "Gianluigi Donnarumma": "GLASS",
  "Jan Oblak": "CALM",
  "Trent Alexander-Arnold": "AMBITIOUS",
  "Kyle Walker": "FIERY",
  "Marquinhos": "CALM",
  "Éder Militão": "CALM",
  "Ronald Araújo": "FIERY",
  "Josko Gvardiol": "CALM",
  "Jules Koundé": "CALM",
  "Reece James": "GLASS",
  "João Cancelo": "FIERY",
  "David Alaba": "CALM",
  "Matthijs de Ligt": "CALM",
  "Andrew Robertson": "FIERY",
  "Bruno Fernandes": "FIERY",
  "Bernardo Silva": "CALM",
  "Frenkie de Jong": "CALM",
  "Declan Rice": "AMBITIOUS",
  "Ilkay Gündogan": "CALM",
  "Nicolò Barella": "FIERY",
  "Jamal Musiala": "AMBITIOUS",
  "Enzo Fernández": "FIERY",
  "Aurélien Tchouaméni": "CALM",
  "Casemiro": "FIERY",
  "Joshua Kimmich": "FIERY",
  "Phil Foden": "GLASS",
  "Bruno Guimarães": "FIERY",
  "Bukayo Saka": "CALM",
  "Rafael Leão": "GLASS",
  "Julián Álvarez": "AMBITIOUS",
  "Victor Osimhen": "FIERY",
  "Marcus Rashford": "GLASS",
  "Lamine Yamal": "AMBITIOUS",
  "Khvicha Kvaratskhelia": "AMBITIOUS",
  "Robert Lewandowski": "AMBITIOUS",

  // ── SILVER (42) ──────────────────────────────────────────────────
  "André Onana": "FIERY",
  "Yann Sommer": "CALM",
  "David Raya": "CALM",
  "Raphaël Varane": "CALM",
  "Lisandro Martínez": "FIERY",
  "Cristian Romero": "FIERY",
  "Gabriel Magalhães": "FIERY",
  "Ben White": "CALM",
  "Pau Torres": "CALM",
  "Nathan Aké": "CALM",
  "Manuel Akanji": "CALM",
  "Alessandro Bastoni": "CALM",
  "Federico Dimarco": "CALM",
  "Destiny Udogie": "GLASS",
  "Marcos Acuña": "FIERY",
  "Jeremie Frimpong": "FIERY",
  "Kieran Trippier": "CALM",
  "Raphaël Guerreiro": "CALM",
  "Mason Mount": "GLASS",
  "Kai Havertz": "GLASS",
  "James Maddison": "FIERY",
  "Dominik Szoboszlai": "AMBITIOUS",
  "Alexis Mac Allister": "CALM",
  "Youri Tielemans": "CALM",
  "Sandro Tonali": "GLASS",
  "Eduardo Camavinga": "AMBITIOUS",
  "Ryan Gravenberch": "GLASS",
  "Fabián Ruiz": "CALM",
  "Teun Koopmeiners": "AMBITIOUS",
  "Weston McKennie": "FIERY",
  "Hakan Çalhanoğlu": "CALM",
  "Amadou Onana": "CALM",
  "Gabriel Jesus": "GLASS",
  "Marcus Thuram": "CALM",
  "Rasmus Højlund": "GLASS",
  "Randal Kolo Muani": "GLASS",
  "Cody Gakpo": "CALM",
  "Ollie Watkins": "AMBITIOUS",
  "Alexander Isak": "AMBITIOUS",
  "Dušan Vlahović": "FIERY",
  "Nicolas Jackson": "GLASS",
  "Serhou Guirassy": "AMBITIOUS",

  // ── BRONZE (27, 인터내셔널) ──────────────────────────────────────
  "Giorgi Mamardashvili": "AMBITIOUS",
  "Guglielmo Vicario": "CALM",
  "Rico Lewis": "GLASS",
  "Levi Colwill": "CALM",
  "Leny Yoro": "AMBITIOUS",
  "Nico Schlotterbeck": "FIERY",
  "Castello Lukeba": "CALM",
  "Riccardo Calafiori": "AMBITIOUS",
  "Giorgio Scalvini": "GLASS",
  "Jarrad Branthwaite": "CALM",
  "Micky van de Ven": "CALM",
  "Warren Zaïre-Emery": "AMBITIOUS",
  "Kobbie Mainoo": "CALM",
  "Gavi": "FIERY",
  "Arda Güler": "GLASS",
  "Carlos Baleba": "AMBITIOUS",
  "Adam Wharton": "CALM",
  "João Neves": "AMBITIOUS",
  "Manu Koné": "FIERY",
  "Ángel Gomes": "GLASS",
  "Endrick": "AMBITIOUS",
  "Mathys Tel": "GLASS",
  "Benjamin Šeško": "AMBITIOUS",
  "Johan Bakayoko": "AMBITIOUS",
  "Karim Adeyemi": "GLASS",
  "Hugo Ekitike": "GLASS",
  "Alejandro Garnacho": "FIERY",

  // ── 한국 (30) ────────────────────────────────────────────────────
  "Park Ji-sung": "AMBITIOUS",
  "Cha Bum-kun": "AMBITIOUS",
  "Lee Kang-in": "FIERY",
  "Ki Sung-yueng": "CALM",
  "Yoo Sang-chul": "CALM",
  "Hong Myung-bo": "CALM",
  "Lee Young-pyo": "CALM",
  "Kim Joo-sung": "CALM",
  "Hwang Hee-chan": "FIERY",
  "Ahn Jung-hwan": "FIERY",
  "Lee Dong-gook": "CALM",
  "Hwang Sun-hong": "CALM",
  "Lee Jae-sung": "CALM",
  "Hwang In-beom": "CALM",
  "Koo Ja-cheol": "CALM",
  "Lee Chung-yong": "CALM",
  "Kim Young-gwon": "CALM",
  "Kim Jin-su": "CALM",
  "Cho Hyun-woo": "FIERY",
  "Park Chu-young": "GLASS",
  "Seol Ki-hyeon": "CALM",
  "Cho Gue-sung": "AMBITIOUS",
  "Bae Jun-ho": "AMBITIOUS",
  "Hong Hyun-seok": "CALM",
  "Paik Seung-ho": "CALM",
  "Seol Young-woo": "CALM",
  "Kim Seung-gyu": "CALM",
  "Yang Min-hyuk": "AMBITIOUS",
  "Oh Hyeon-gyu": "GLASS",
  "Yang Hyun-jun": "GLASS",

  // ── 신규 LEGEND 8종 (#207 U-D4, P173~P180) ───────────────────────
  // U-D4 표는 traits 까지만 확정했다. personality 파생 규칙 = **소스 실선수의 성격을 그대로
  // 복제**(위 매핑에서 조회), 로스터에 소스가 없는 2종(보날두=CR7 / 권씨=메시)만 §8.1 기준으로
  // 신규 배정한다 — U-D2 가 traits 를 벤치마크로 신규 작성한 것과 같은 방식.
  "보날두": "AMBITIOUS", // CR7 — 기록·자기증명 지향(§8.1 야심가). 소스가 로스터에 없어 신규 배정.
  "권씨": "CALM", // 메시 — 압박에도 흔들리지 않는 안정형(§8.1 침착). 신규 배정.
  "유라도나": "FIERY", // ← Diego Maradona(P005) 복제
  "춘바페": "AMBITIOUS", // ← Kylian Mbappé 복제
  "덕브라이너": "FIERY", // ← Kevin De Bruyne 복제
  "석신": "CALM", // ← Lev Yashin(P001) 복제
  "욱리엄": "FIERY", // ← Jude Bellingham 복제
  "경니시우스": "FIERY", // ← Vinícius Júnior 복제

  // ── 신규 LEGEND 2종 (#256, P181~P182) ────────────────────────────
  // 위 블록과 같은 파생 규칙: 소스가 로스터에 있으면 그 성격을 복제, 없으면 §8.1 기준 신규 배정.
  "석다이크": "CALM", // ← Virgil van Dijk(P015) 복제
  "오시야스": "CALM", // 카시야스 — 압박 상황에서 흔들리지 않는 안정형 리더(§8.1 침착). 소스가 로스터에 없어 신규 배정.
};
