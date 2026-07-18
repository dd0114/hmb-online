/**
 * roster — 실선수 큐레이션 로스터 (v2).
 *
 * hero 요구(2026-07-19, 이슈 #84): 선수 풀을 유명 실선수로 전량 교체 — 유럽 빅클럽 현역 +
 * 역대 레전드. '실선수 금지'(구 규칙, PoC 가상풀 전제)는 이 시점에서 **실명 허용**으로 갱신됨.
 * ⚠️ 상용화 전 초상권/라이선스 해결 필수(백로그) — data/CLAUDE.md·PRD-v2 D4 주석 참조.
 *
 * 이 파일은 **큐레이션 정적 데이터**(수기 작성)다. 각 선수의 이름·포지션·등급·시그니처 특성만
 * 담고, 실제 9종 능력치는 generate.ts 가 시드 RNG로 등급 밴드 내에서 결정론 생성한다
 * (포지션 주스탯 +5, trait 스탯 +6, 밴드 클램프). 즉 로스터는 "누구를 어느 등급에" 만 정하고
 * 수치는 재현 가능하게 파생 — 바이트 동일 재생성(AC-D2) 유지.
 *
 * 등급 매핑 기준(docs/plan-v2/grade-mapping-v2.md 에 문서화):
 *   LEGEND = 역대 레전드 전성기(축구사 정상급)
 *   DIA    = 현역 월드클래스 빅클럽 주전(발롱도르권)
 *   GOLD   = 빅클럽 확실한 주전
 *   SILVER = 로테이션·준주전(좋은 클럽)
 *   BRONZE = 백업·유망주(프로스펙트)
 *
 * traits = 그 선수의 시그니처 능력치(밴드 내 +6 바이어스). 능력치 9종 키만 허용.
 * 로스터 순서 = ID 배정 순서(P001..P172). 등급 desc → 포지션(GK,DF,MF,FW) 블록으로 정렬.
 */
import type { Position, Grade, PlayerAttributes } from "./generate";

export interface RosterEntry {
  name: string;
  position: Position;
  grade: Grade;
  /** 시그니처 능력치(0~2종). 밴드 내 +6 바이어스 대상. */
  traits: readonly (keyof PlayerAttributes)[];
}

/**
 * 실선수 172명(인터내셔널 142 + 한국 30, hero 요청 #84). 등급 분포:
 *   LEGEND 14 / DIA 25 / GOLD 46 / SILVER 52 / BRONZE 35.
 * 포지션 분포: GK 13 / DF 53 / MF 59 / FW 47. (문서화된 총원 — data.test.ts 가 리터럴로 검증)
 * GK 는 컬렉션 비중을 낮춤(팀당 선발 1명) — hero 지적 반영해 19→13.
 * 아래 섹션 헤더의 (n) 은 그 블록 인원(인터내셔널 블록은 국제 선수 기준, 한국 블록은 별도 30).
 */
export const ROSTER: readonly RosterEntry[] = [
  // ── LEGEND (12) — 역대 레전드 전성기 ─────────────────────────────
  { name: "Lev Yashin", position: "GK", grade: "LEGEND", traits: ["positioning", "mental"] },
  { name: "Franz Beckenbauer", position: "DF", grade: "LEGEND", traits: ["passing", "positioning"] },
  { name: "Paolo Maldini", position: "DF", grade: "LEGEND", traits: ["tackling", "positioning"] },
  { name: "Franco Baresi", position: "DF", grade: "LEGEND", traits: ["tackling", "mental"] },
  { name: "Diego Maradona", position: "MF", grade: "LEGEND", traits: ["technical", "shooting"] },
  { name: "Zinedine Zidane", position: "MF", grade: "LEGEND", traits: ["technical", "passing"] },
  { name: "Michel Platini", position: "MF", grade: "LEGEND", traits: ["passing", "shooting"] },
  { name: "Lothar Matthäus", position: "MF", grade: "LEGEND", traits: ["physical", "shooting"] },
  { name: "Pelé", position: "FW", grade: "LEGEND", traits: ["shooting", "technical"] },
  { name: "Ronaldo Nazário", position: "FW", grade: "LEGEND", traits: ["pace", "shooting"] },
  { name: "Johan Cruyff", position: "FW", grade: "LEGEND", traits: ["technical", "passing"] },
  { name: "Marco van Basten", position: "FW", grade: "LEGEND", traits: ["shooting", "positioning"] },

  // ── DIA (25) — 현역 월드클래스 빅클럽 주전 (한국 간판 손흥민·김민재 격상 포함) ──
  { name: "Alisson", position: "GK", grade: "DIA", traits: ["positioning", "mental"] },
  { name: "Thibaut Courtois", position: "GK", grade: "DIA", traits: ["positioning", "physical"] },
  { name: "Virgil van Dijk", position: "DF", grade: "DIA", traits: ["tackling", "physical"] },
  { name: "Rúben Dias", position: "DF", grade: "DIA", traits: ["tackling", "positioning"] },
  { name: "Achraf Hakimi", position: "DF", grade: "DIA", traits: ["pace", "stamina"] },
  { name: "Alphonso Davies", position: "DF", grade: "DIA", traits: ["pace", "stamina"] },
  { name: "Antonio Rüdiger", position: "DF", grade: "DIA", traits: ["physical", "tackling"] },
  { name: "William Saliba", position: "DF", grade: "DIA", traits: ["tackling", "pace"] },
  { name: "Theo Hernández", position: "DF", grade: "DIA", traits: ["pace", "shooting"] },
  { name: "Kim Min-jae", position: "DF", grade: "DIA", traits: ["physical", "tackling"] },
  { name: "Rodri", position: "MF", grade: "DIA", traits: ["passing", "positioning"] },
  { name: "Kevin De Bruyne", position: "MF", grade: "DIA", traits: ["passing", "shooting"] },
  { name: "Jude Bellingham", position: "MF", grade: "DIA", traits: ["physical", "shooting"] },
  { name: "Federico Valverde", position: "MF", grade: "DIA", traits: ["stamina", "physical"] },
  { name: "Luka Modrić", position: "MF", grade: "DIA", traits: ["passing", "technical"] },
  { name: "Toni Kroos", position: "MF", grade: "DIA", traits: ["passing", "mental"] },
  { name: "Martin Ødegaard", position: "MF", grade: "DIA", traits: ["passing", "technical"] },
  { name: "Pedri", position: "MF", grade: "DIA", traits: ["technical", "passing"] },
  { name: "Erling Haaland", position: "FW", grade: "DIA", traits: ["shooting", "physical"] },
  { name: "Kylian Mbappé", position: "FW", grade: "DIA", traits: ["pace", "shooting"] },
  { name: "Vinícius Júnior", position: "FW", grade: "DIA", traits: ["pace", "technical"] },
  { name: "Harry Kane", position: "FW", grade: "DIA", traits: ["shooting", "passing"] },
  { name: "Mohamed Salah", position: "FW", grade: "DIA", traits: ["pace", "shooting"] },
  { name: "Lautaro Martínez", position: "FW", grade: "DIA", traits: ["shooting", "positioning"] },
  { name: "Son Heung-min", position: "FW", grade: "DIA", traits: ["shooting", "pace"] },

  // ── GOLD (36) — 빅클럽 확실한 주전 ───────────────────────────────
  { name: "Ederson", position: "GK", grade: "GOLD", traits: ["passing", "positioning"] },
  { name: "Gianluigi Donnarumma", position: "GK", grade: "GOLD", traits: ["positioning", "physical"] },
  { name: "Jan Oblak", position: "GK", grade: "GOLD", traits: ["positioning", "mental"] },
  { name: "Trent Alexander-Arnold", position: "DF", grade: "GOLD", traits: ["passing", "technical"] },
  { name: "Kyle Walker", position: "DF", grade: "GOLD", traits: ["pace", "physical"] },
  { name: "Marquinhos", position: "DF", grade: "GOLD", traits: ["tackling", "positioning"] },
  { name: "Éder Militão", position: "DF", grade: "GOLD", traits: ["pace", "physical"] },
  { name: "Ronald Araújo", position: "DF", grade: "GOLD", traits: ["physical", "tackling"] },
  { name: "Josko Gvardiol", position: "DF", grade: "GOLD", traits: ["physical", "pace"] },
  { name: "Jules Koundé", position: "DF", grade: "GOLD", traits: ["pace", "tackling"] },
  { name: "Reece James", position: "DF", grade: "GOLD", traits: ["physical", "passing"] },
  { name: "João Cancelo", position: "DF", grade: "GOLD", traits: ["passing", "technical"] },
  { name: "David Alaba", position: "DF", grade: "GOLD", traits: ["passing", "positioning"] },
  { name: "Matthijs de Ligt", position: "DF", grade: "GOLD", traits: ["tackling", "physical"] },
  { name: "Andrew Robertson", position: "DF", grade: "GOLD", traits: ["stamina", "passing"] },
  { name: "Bruno Fernandes", position: "MF", grade: "GOLD", traits: ["passing", "shooting"] },
  { name: "Bernardo Silva", position: "MF", grade: "GOLD", traits: ["technical", "stamina"] },
  { name: "Frenkie de Jong", position: "MF", grade: "GOLD", traits: ["technical", "passing"] },
  { name: "Declan Rice", position: "MF", grade: "GOLD", traits: ["tackling", "physical"] },
  { name: "Ilkay Gündogan", position: "MF", grade: "GOLD", traits: ["passing", "positioning"] },
  { name: "Nicolò Barella", position: "MF", grade: "GOLD", traits: ["stamina", "passing"] },
  { name: "Jamal Musiala", position: "MF", grade: "GOLD", traits: ["technical", "pace"] },
  { name: "Enzo Fernández", position: "MF", grade: "GOLD", traits: ["passing", "stamina"] },
  { name: "Aurélien Tchouaméni", position: "MF", grade: "GOLD", traits: ["tackling", "physical"] },
  { name: "Casemiro", position: "MF", grade: "GOLD", traits: ["tackling", "physical"] },
  { name: "Joshua Kimmich", position: "MF", grade: "GOLD", traits: ["passing", "mental"] },
  { name: "Phil Foden", position: "MF", grade: "GOLD", traits: ["technical", "shooting"] },
  { name: "Bruno Guimarães", position: "MF", grade: "GOLD", traits: ["passing", "tackling"] },
  { name: "Bukayo Saka", position: "FW", grade: "GOLD", traits: ["technical", "pace"] },
  { name: "Rafael Leão", position: "FW", grade: "GOLD", traits: ["pace", "technical"] },
  { name: "Julián Álvarez", position: "FW", grade: "GOLD", traits: ["shooting", "stamina"] },
  { name: "Victor Osimhen", position: "FW", grade: "GOLD", traits: ["pace", "shooting"] },
  { name: "Marcus Rashford", position: "FW", grade: "GOLD", traits: ["pace", "shooting"] },
  { name: "Lamine Yamal", position: "FW", grade: "GOLD", traits: ["technical", "pace"] },
  { name: "Khvicha Kvaratskhelia", position: "FW", grade: "GOLD", traits: ["technical", "pace"] },
  { name: "Robert Lewandowski", position: "FW", grade: "GOLD", traits: ["shooting", "positioning"] },

  // ── SILVER (42) — 로테이션·준주전 ────────────────────────────────
  { name: "André Onana", position: "GK", grade: "SILVER", traits: ["passing", "positioning"] },
  { name: "Yann Sommer", position: "GK", grade: "SILVER", traits: ["positioning", "mental"] },
  { name: "David Raya", position: "GK", grade: "SILVER", traits: ["passing", "positioning"] },
  { name: "Raphaël Varane", position: "DF", grade: "SILVER", traits: ["tackling", "positioning"] },
  { name: "Lisandro Martínez", position: "DF", grade: "SILVER", traits: ["tackling", "technical"] },
  { name: "Cristian Romero", position: "DF", grade: "SILVER", traits: ["tackling", "physical"] },
  { name: "Gabriel Magalhães", position: "DF", grade: "SILVER", traits: ["physical", "tackling"] },
  { name: "Ben White", position: "DF", grade: "SILVER", traits: ["tackling", "passing"] },
  { name: "Pau Torres", position: "DF", grade: "SILVER", traits: ["passing", "positioning"] },
  { name: "Nathan Aké", position: "DF", grade: "SILVER", traits: ["tackling", "pace"] },
  { name: "Manuel Akanji", position: "DF", grade: "SILVER", traits: ["passing", "tackling"] },
  { name: "Alessandro Bastoni", position: "DF", grade: "SILVER", traits: ["passing", "tackling"] },
  { name: "Federico Dimarco", position: "DF", grade: "SILVER", traits: ["passing", "stamina"] },
  { name: "Destiny Udogie", position: "DF", grade: "SILVER", traits: ["pace", "stamina"] },
  { name: "Marcos Acuña", position: "DF", grade: "SILVER", traits: ["stamina", "tackling"] },
  { name: "Jeremie Frimpong", position: "DF", grade: "SILVER", traits: ["pace", "stamina"] },
  { name: "Kieran Trippier", position: "DF", grade: "SILVER", traits: ["passing", "stamina"] },
  { name: "Raphaël Guerreiro", position: "DF", grade: "SILVER", traits: ["passing", "technical"] },
  { name: "Mason Mount", position: "MF", grade: "SILVER", traits: ["stamina", "passing"] },
  { name: "Kai Havertz", position: "MF", grade: "SILVER", traits: ["physical", "shooting"] },
  { name: "James Maddison", position: "MF", grade: "SILVER", traits: ["passing", "technical"] },
  { name: "Dominik Szoboszlai", position: "MF", grade: "SILVER", traits: ["shooting", "stamina"] },
  { name: "Alexis Mac Allister", position: "MF", grade: "SILVER", traits: ["passing", "mental"] },
  { name: "Youri Tielemans", position: "MF", grade: "SILVER", traits: ["passing", "shooting"] },
  { name: "Sandro Tonali", position: "MF", grade: "SILVER", traits: ["tackling", "passing"] },
  { name: "Eduardo Camavinga", position: "MF", grade: "SILVER", traits: ["physical", "tackling"] },
  { name: "Ryan Gravenberch", position: "MF", grade: "SILVER", traits: ["technical", "physical"] },
  { name: "Fabián Ruiz", position: "MF", grade: "SILVER", traits: ["passing", "technical"] },
  { name: "Teun Koopmeiners", position: "MF", grade: "SILVER", traits: ["passing", "shooting"] },
  { name: "Weston McKennie", position: "MF", grade: "SILVER", traits: ["stamina", "physical"] },
  { name: "Hakan Çalhanoğlu", position: "MF", grade: "SILVER", traits: ["passing", "shooting"] },
  { name: "Amadou Onana", position: "MF", grade: "SILVER", traits: ["physical", "tackling"] },
  { name: "Gabriel Jesus", position: "FW", grade: "SILVER", traits: ["technical", "stamina"] },
  { name: "Marcus Thuram", position: "FW", grade: "SILVER", traits: ["physical", "pace"] },
  { name: "Rasmus Højlund", position: "FW", grade: "SILVER", traits: ["pace", "physical"] },
  { name: "Randal Kolo Muani", position: "FW", grade: "SILVER", traits: ["pace", "physical"] },
  { name: "Cody Gakpo", position: "FW", grade: "SILVER", traits: ["pace", "shooting"] },
  { name: "Ollie Watkins", position: "FW", grade: "SILVER", traits: ["pace", "shooting"] },
  { name: "Alexander Isak", position: "FW", grade: "SILVER", traits: ["shooting", "technical"] },
  { name: "Dušan Vlahović", position: "FW", grade: "SILVER", traits: ["shooting", "physical"] },
  { name: "Nicolas Jackson", position: "FW", grade: "SILVER", traits: ["pace", "stamina"] },
  { name: "Serhou Guirassy", position: "FW", grade: "SILVER", traits: ["shooting", "physical"] },

  // ── BRONZE (27) — 백업·유망주(프로스펙트) ────────────────────────
  { name: "Giorgi Mamardashvili", position: "GK", grade: "BRONZE", traits: ["positioning", "physical"] },
  { name: "Guglielmo Vicario", position: "GK", grade: "BRONZE", traits: ["positioning", "mental"] },
  { name: "Rico Lewis", position: "DF", grade: "BRONZE", traits: ["passing", "stamina"] },
  { name: "Levi Colwill", position: "DF", grade: "BRONZE", traits: ["tackling", "passing"] },
  { name: "Leny Yoro", position: "DF", grade: "BRONZE", traits: ["tackling", "physical"] },
  { name: "Nico Schlotterbeck", position: "DF", grade: "BRONZE", traits: ["passing", "tackling"] },
  { name: "Castello Lukeba", position: "DF", grade: "BRONZE", traits: ["tackling", "pace"] },
  { name: "Riccardo Calafiori", position: "DF", grade: "BRONZE", traits: ["physical", "passing"] },
  { name: "Giorgio Scalvini", position: "DF", grade: "BRONZE", traits: ["physical", "tackling"] },
  { name: "Jarrad Branthwaite", position: "DF", grade: "BRONZE", traits: ["tackling", "physical"] },
  { name: "Micky van de Ven", position: "DF", grade: "BRONZE", traits: ["pace", "tackling"] },
  { name: "Warren Zaïre-Emery", position: "MF", grade: "BRONZE", traits: ["stamina", "passing"] },
  { name: "Kobbie Mainoo", position: "MF", grade: "BRONZE", traits: ["technical", "tackling"] },
  { name: "Gavi", position: "MF", grade: "BRONZE", traits: ["stamina", "technical"] },
  { name: "Arda Güler", position: "MF", grade: "BRONZE", traits: ["technical", "shooting"] },
  { name: "Carlos Baleba", position: "MF", grade: "BRONZE", traits: ["physical", "tackling"] },
  { name: "Adam Wharton", position: "MF", grade: "BRONZE", traits: ["passing", "mental"] },
  { name: "João Neves", position: "MF", grade: "BRONZE", traits: ["stamina", "tackling"] },
  { name: "Manu Koné", position: "MF", grade: "BRONZE", traits: ["physical", "stamina"] },
  { name: "Ángel Gomes", position: "MF", grade: "BRONZE", traits: ["technical", "passing"] },
  { name: "Endrick", position: "FW", grade: "BRONZE", traits: ["shooting", "pace"] },
  { name: "Mathys Tel", position: "FW", grade: "BRONZE", traits: ["pace", "technical"] },
  { name: "Benjamin Šeško", position: "FW", grade: "BRONZE", traits: ["shooting", "physical"] },
  { name: "Johan Bakayoko", position: "FW", grade: "BRONZE", traits: ["pace", "technical"] },
  { name: "Karim Adeyemi", position: "FW", grade: "BRONZE", traits: ["pace", "stamina"] },
  { name: "Hugo Ekitike", position: "FW", grade: "BRONZE", traits: ["pace", "technical"] },
  { name: "Alejandro Garnacho", position: "FW", grade: "BRONZE", traits: ["pace", "technical"] },

  // ── 한국 유명 선수 (30, hero 요청) — 로마자 표기, 국내/세계 위상 반영 ──
  // (간판 손흥민·김민재는 위 DIA 블록으로 격상 배치 — 여기 30명은 신규 추가분)
  // LEGEND (2) — 세계 무대 한국 레전드
  { name: "Park Ji-sung", position: "MF", grade: "LEGEND", traits: ["stamina", "mental"] },
  { name: "Cha Bum-kun", position: "FW", grade: "LEGEND", traits: ["shooting", "physical"] },
  // GOLD (10)
  { name: "Lee Kang-in", position: "MF", grade: "GOLD", traits: ["technical", "passing"] },
  { name: "Ki Sung-yueng", position: "MF", grade: "GOLD", traits: ["passing", "mental"] },
  { name: "Yoo Sang-chul", position: "MF", grade: "GOLD", traits: ["physical", "shooting"] },
  { name: "Hong Myung-bo", position: "DF", grade: "GOLD", traits: ["positioning", "passing"] },
  { name: "Lee Young-pyo", position: "DF", grade: "GOLD", traits: ["pace", "stamina"] },
  { name: "Kim Joo-sung", position: "DF", grade: "GOLD", traits: ["tackling", "physical"] },
  { name: "Hwang Hee-chan", position: "FW", grade: "GOLD", traits: ["pace", "physical"] },
  { name: "Ahn Jung-hwan", position: "FW", grade: "GOLD", traits: ["technical", "shooting"] },
  { name: "Lee Dong-gook", position: "FW", grade: "GOLD", traits: ["shooting", "positioning"] },
  { name: "Hwang Sun-hong", position: "FW", grade: "GOLD", traits: ["shooting", "physical"] },
  // SILVER (10)
  { name: "Lee Jae-sung", position: "MF", grade: "SILVER", traits: ["stamina", "passing"] },
  { name: "Hwang In-beom", position: "MF", grade: "SILVER", traits: ["passing", "technical"] },
  { name: "Koo Ja-cheol", position: "MF", grade: "SILVER", traits: ["passing", "shooting"] },
  { name: "Lee Chung-yong", position: "MF", grade: "SILVER", traits: ["technical", "passing"] },
  { name: "Kim Young-gwon", position: "DF", grade: "SILVER", traits: ["positioning", "tackling"] },
  { name: "Kim Jin-su", position: "DF", grade: "SILVER", traits: ["stamina", "passing"] },
  { name: "Cho Hyun-woo", position: "GK", grade: "SILVER", traits: ["positioning", "mental"] },
  { name: "Park Chu-young", position: "FW", grade: "SILVER", traits: ["technical", "shooting"] },
  { name: "Seol Ki-hyeon", position: "FW", grade: "SILVER", traits: ["physical", "pace"] },
  { name: "Cho Gue-sung", position: "FW", grade: "SILVER", traits: ["physical", "shooting"] },
  // BRONZE (8) — 백업·유망주
  { name: "Bae Jun-ho", position: "MF", grade: "BRONZE", traits: ["technical", "pace"] },
  { name: "Hong Hyun-seok", position: "MF", grade: "BRONZE", traits: ["passing", "shooting"] },
  { name: "Paik Seung-ho", position: "MF", grade: "BRONZE", traits: ["passing", "stamina"] },
  { name: "Seol Young-woo", position: "DF", grade: "BRONZE", traits: ["stamina", "pace"] },
  { name: "Kim Seung-gyu", position: "GK", grade: "BRONZE", traits: ["positioning", "mental"] },
  { name: "Yang Min-hyuk", position: "FW", grade: "BRONZE", traits: ["pace", "technical"] },
  { name: "Oh Hyeon-gyu", position: "FW", grade: "BRONZE", traits: ["physical", "pace"] },
  { name: "Yang Hyun-jun", position: "FW", grade: "BRONZE", traits: ["pace", "technical"] },
];
