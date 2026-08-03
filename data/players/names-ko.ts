/**
 * names-ko — 선수 **한글 표기** 큐레이션 (players v2.5, 에픽 #406 요구 6 / hero 확정 "안 C 하이브리드").
 *
 * hero 결정(2026-08-02, #406 게이트): 실선수 172명은 **한글 음역**, 패러디 10명(P173~P182)은
 * **현행 유지**. 승인 원본 = `docs/plan-v5/mock/406-matchux/names.draft.json`(hero 검사 통과) —
 * 이 파일은 그 결정을 data 도메인 안으로 **박제**한 것이다(mock 문서를 생성기가 import 하지 않는다).
 *
 * ⚠️ **roster.ts 의 `name`(영문)은 고치지 않는다.** 그 배열은 시드 RNG 스트림의 순서이자
 * `FROZEN_ROSTER_COUNT`(172)·`FROZEN_ROSTER_COUNT_V22`(180) 슬라이스로 과거 발행물
 * (v2/v2.1/v2.2/v2.3/v2.4)을 **바이트 동일 재현**하는 축이다. 영문명을 갈아치우면 그 재현이
 * 통째로 깨진다(#207 U-D6 가 ROSTER 대신 `V23_NAME_CORRECTIONS` 를 쓴 것과 같은 이유).
 * 한글 이름은 **v2.5 레이어에서만** `name` 자리에 실린다.
 *
 * 필드:
 *   from  — 이 표를 만든 시점의 **v2.4 발행물 이름**. 빌더가 대조해 fail-closed 로 터진다
 *           (로스터가 밀리거나 누가 v2.3 정정을 되돌리면 조용히 엉뚱한 선수를 개명하지 않는다).
 *   ko    — v2.5 에서 `name` 에 실릴 한글 표기. **패러디 유닛에는 없다**(= 현행 이름 유지가
 *           구조적으로 보장된다 — 값을 안 쓰니 오타로 바뀔 수도 없다).
 *   short — 밀집 UI(덱 행·전술보드 슬롯·경기 토큰·로그줄)용 짧은 이름. **전원 필수**.
 *           풀네임이 안 들어가는 자리에서 쓴다. 알려진 중복 2쌍(오나나·루이스)은 의도된 상태다
 *           — 성만 남기면 겹치는 실제 동성 선수이고, 구분이 필요한 화면은 풀네임을 쓴다.
 *
 * 공백을 포함한다(예: "판 바스턴" · "더 브라위너") — 네덜란드계 전치사 성은 붙여 쓰면 오히려
 * 읽기 어렵다. 한글 가드는 `[가-힣 ]` 로 건다.
 */
export interface KoreanNameEntry {
  id: string;
  /** 대조 앵커 = players.v2.4.json 의 현재 name. 다르면 빌더가 즉시 throw. */
  from: string;
  /** 한글 표기(실선수 172명). 패러디 유닛은 undefined = 현행 이름 유지. */
  ko?: string;
  /** 밀집 UI 용 짧은 이름(182명 전원). */
  short: string;
}

/** 발행 순서(P001..P182)와 동일 — 빌더가 id 로 조인하고 개수·순서를 함께 검증한다. */
export const NAMES_KO: readonly KoreanNameEntry[] = [
  { id: "P001", from: "Lev Yashin", ko: "레프 야신", short: "야신" },
  { id: "P002", from: "Franz Beckenbauer", ko: "프란츠 베켄바워", short: "베켄바워" },
  { id: "P003", from: "Paolo Maldini", ko: "파올로 말디니", short: "말디니" },
  { id: "P004", from: "Franco Baresi", ko: "프랑코 바레시", short: "바레시" },
  { id: "P005", from: "Diego Maradona", ko: "디에고 마라도나", short: "마라도나" },
  { id: "P006", from: "Zinedine Zidane", ko: "지네딘 지단", short: "지단" },
  { id: "P007", from: "Michel Platini", ko: "미셸 플라티니", short: "플라티니" },
  { id: "P008", from: "Lothar Matthäus", ko: "로타어 마테우스", short: "마테우스" },
  { id: "P009", from: "Pelé", ko: "펠레", short: "펠레" },
  { id: "P010", from: "Ronaldo Nazário", ko: "호나우두 나자리우", short: "호나우두" },
  { id: "P011", from: "Johan Cruyff", ko: "요한 크루이프", short: "크루이프" },
  { id: "P012", from: "Marco van Basten", ko: "마르코 판 바스턴", short: "판 바스턴" },
  { id: "P013", from: "Alisson", ko: "알리송", short: "알리송" },
  { id: "P014", from: "Thibaut Courtois", ko: "티보 쿠르투아", short: "쿠르투아" },
  { id: "P015", from: "Virgil van Dijk", ko: "버질 판다이크", short: "판다이크" },
  { id: "P016", from: "Rúben Dias", ko: "후벵 디아스", short: "디아스" },
  { id: "P017", from: "Achraf Hakimi", ko: "아슈라프 하키미", short: "하키미" },
  { id: "P018", from: "Alphonso Davies", ko: "알폰소 데이비스", short: "데이비스" },
  { id: "P019", from: "Antonio Rüdiger", ko: "안토니오 뤼디거", short: "뤼디거" },
  { id: "P020", from: "William Saliba", ko: "윌리앙 살리바", short: "살리바" },
  { id: "P021", from: "Theo Hernández", ko: "테오 에르난데스", short: "테오" },
  { id: "P022", from: "Kim Min-jae", ko: "김민재", short: "김민재" },
  { id: "P023", from: "Rodri", ko: "로드리", short: "로드리" },
  { id: "P024", from: "Kevin De Bruyne", ko: "케빈 더 브라위너", short: "더 브라위너" },
  { id: "P025", from: "Jude Bellingham", ko: "주드 벨링엄", short: "벨링엄" },
  { id: "P026", from: "Federico Valverde", ko: "페데리코 발베르데", short: "발베르데" },
  { id: "P027", from: "Luka Modrić", ko: "루카 모드리치", short: "모드리치" },
  { id: "P028", from: "Toni Kroos", ko: "토니 크로스", short: "크로스" },
  { id: "P029", from: "Martin Ødegaard", ko: "마르틴 외데고르", short: "외데고르" },
  { id: "P030", from: "Pedri", ko: "페드리", short: "페드리" },
  { id: "P031", from: "Erling Haaland", ko: "엘링 홀란", short: "홀란" },
  { id: "P032", from: "Kylian Mbappé", ko: "킬리안 음바페", short: "음바페" },
  { id: "P033", from: "Vinícius Júnior", ko: "비니시우스 주니오르", short: "비니시우스" },
  { id: "P034", from: "Harry Kane", ko: "해리 케인", short: "케인" },
  { id: "P035", from: "Mohamed Salah", ko: "모하메드 살라", short: "살라" },
  { id: "P036", from: "Lautaro Martínez", ko: "라우타로 마르티네스", short: "라우타로" },
  { id: "P037", from: "Son Heung-min", ko: "손흥민", short: "손흥민" },
  { id: "P038", from: "Ederson", ko: "에데르송", short: "에데르송" },
  { id: "P039", from: "Gianluigi Donnarumma", ko: "잔루이지 돈나룸마", short: "돈나룸마" },
  { id: "P040", from: "Jan Oblak", ko: "얀 오블라크", short: "오블라크" },
  { id: "P041", from: "Trent Alexander-Arnold", ko: "트렌트 알렉산더아널드", short: "알렉산더아널드" },
  { id: "P042", from: "Kyle Walker", ko: "카일 워커", short: "워커" },
  { id: "P043", from: "Marquinhos", ko: "마르키뉴스", short: "마르키뉴스" },
  { id: "P044", from: "Éder Militão", ko: "에데르 밀리탕", short: "밀리탕" },
  { id: "P045", from: "Ronald Araújo", ko: "로날드 아라우호", short: "아라우호" },
  { id: "P046", from: "Josko Gvardiol", ko: "요슈코 그바르디올", short: "그바르디올" },
  { id: "P047", from: "Jules Koundé", ko: "쥘 쿤데", short: "쿤데" },
  { id: "P048", from: "Reece James", ko: "리스 제임스", short: "제임스" },
  { id: "P049", from: "João Cancelo", ko: "주앙 칸셀루", short: "칸셀루" },
  { id: "P050", from: "David Alaba", ko: "다비드 알라바", short: "알라바" },
  { id: "P051", from: "Matthijs de Ligt", ko: "마테이스 더 리흐트", short: "더 리흐트" },
  { id: "P052", from: "Andrew Robertson", ko: "앤드루 로버트슨", short: "로버트슨" },
  { id: "P053", from: "Bruno Fernandes", ko: "브루누 페르난드스", short: "페르난드스" },
  { id: "P054", from: "Bernardo Silva", ko: "베르나르두 실바", short: "베르나르두" },
  { id: "P055", from: "Frenkie de Jong", ko: "프렝키 더 용", short: "더 용" },
  { id: "P056", from: "Declan Rice", ko: "데클런 라이스", short: "라이스" },
  { id: "P057", from: "Ilkay Gündogan", ko: "일카이 귄도안", short: "귄도안" },
  { id: "P058", from: "Nicolò Barella", ko: "니콜로 바렐라", short: "바렐라" },
  { id: "P059", from: "Jamal Musiala", ko: "자말 무시알라", short: "무시알라" },
  { id: "P060", from: "Enzo Fernández", ko: "엔소 페르난데스", short: "엔소" },
  { id: "P061", from: "Aurélien Tchouaméni", ko: "오렐리앵 추아메니", short: "추아메니" },
  { id: "P062", from: "Casemiro", ko: "카세미루", short: "카세미루" },
  { id: "P063", from: "Joshua Kimmich", ko: "요주아 키미히", short: "키미히" },
  { id: "P064", from: "Phil Foden", ko: "필 포든", short: "포든" },
  { id: "P065", from: "Bruno Guimarães", ko: "브루누 기마랑이스", short: "기마랑이스" },
  { id: "P066", from: "Bukayo Saka", ko: "부카요 사카", short: "사카" },
  { id: "P067", from: "Rafael Leão", ko: "하파엘 레앙", short: "레앙" },
  { id: "P068", from: "Julián Álvarez", ko: "훌리안 알바레스", short: "알바레스" },
  { id: "P069", from: "Victor Osimhen", ko: "빅터 오시멘", short: "오시멘" },
  { id: "P070", from: "Marcus Rashford", ko: "마커스 래시퍼드", short: "래시퍼드" },
  { id: "P071", from: "Lamine Yamal", ko: "라민 야말", short: "야말" },
  { id: "P072", from: "Khvicha Kvaratskhelia", ko: "흐비차 크바라츠헬리아", short: "크바라츠헬리아" },
  { id: "P073", from: "Robert Lewandowski", ko: "로베르트 레반도프스키", short: "레반도프스키" },
  { id: "P074", from: "André Onana", ko: "앙드레 오나나", short: "오나나" },
  { id: "P075", from: "Yann Sommer", ko: "얀 조머", short: "조머" },
  { id: "P076", from: "David Raya", ko: "다비드 라야", short: "라야" },
  { id: "P077", from: "Raphaël Varane", ko: "라파엘 바란", short: "바란" },
  { id: "P078", from: "Lisandro Martínez", ko: "리산드로 마르티네스", short: "리산드로" },
  { id: "P079", from: "Cristian Romero", ko: "크리스티안 로메로", short: "로메로" },
  { id: "P080", from: "Gabriel Magalhães", ko: "가브리에우 마갈량이스", short: "가브리에우" },
  { id: "P081", from: "Ben White", ko: "벤 화이트", short: "화이트" },
  { id: "P082", from: "Pau Torres", ko: "파우 토레스", short: "토레스" },
  { id: "P083", from: "Nathan Aké", ko: "네이선 아케", short: "아케" },
  { id: "P084", from: "Manuel Akanji", ko: "마누엘 아칸지", short: "아칸지" },
  { id: "P085", from: "Alessandro Bastoni", ko: "알레산드로 바스토니", short: "바스토니" },
  { id: "P086", from: "Federico Dimarco", ko: "페데리코 디마르코", short: "디마르코" },
  { id: "P087", from: "Destiny Udogie", ko: "데스티니 우도지", short: "우도지" },
  { id: "P088", from: "Marcos Acuña", ko: "마르코스 아쿠냐", short: "아쿠냐" },
  { id: "P089", from: "Jeremie Frimpong", ko: "제레미 프림퐁", short: "프림퐁" },
  { id: "P090", from: "Kieran Trippier", ko: "키어런 트리피어", short: "트리피어" },
  { id: "P091", from: "Raphaël Guerreiro", ko: "하파엘 게레이루", short: "게레이루" },
  { id: "P092", from: "Mason Mount", ko: "메이슨 마운트", short: "마운트" },
  { id: "P093", from: "Kai Havertz", ko: "카이 하베르츠", short: "하베르츠" },
  { id: "P094", from: "James Maddison", ko: "제임스 매디슨", short: "매디슨" },
  { id: "P095", from: "Dominik Szoboszlai", ko: "도미니크 소보슬러이", short: "소보슬러이" },
  { id: "P096", from: "Alexis Mac Allister", ko: "알렉시스 맥 알리스터", short: "맥 알리스터" },
  { id: "P097", from: "Youri Tielemans", ko: "유리 틸레만스", short: "틸레만스" },
  { id: "P098", from: "Sandro Tonali", ko: "산드로 토날리", short: "토날리" },
  { id: "P099", from: "Eduardo Camavinga", ko: "에두아르도 카마빙가", short: "카마빙가" },
  { id: "P100", from: "Ryan Gravenberch", ko: "라이언 흐라번베르흐", short: "흐라번베르흐" },
  { id: "P101", from: "Fabián Ruiz", ko: "파비안 루이스", short: "루이스" },
  { id: "P102", from: "Teun Koopmeiners", ko: "테윈 코프메이너스", short: "코프메이너스" },
  { id: "P103", from: "Weston McKennie", ko: "웨스턴 매케니", short: "매케니" },
  { id: "P104", from: "Hakan Çalhanoğlu", ko: "하칸 찰하노글루", short: "찰하노글루" },
  { id: "P105", from: "Amadou Onana", ko: "아마두 오나나", short: "오나나" },
  { id: "P106", from: "Gabriel Jesus", ko: "가브리에우 제주스", short: "제주스" },
  { id: "P107", from: "Marcus Thuram", ko: "마르퀴스 튀랑", short: "튀랑" },
  { id: "P108", from: "Rasmus Højlund", ko: "라스무스 호일룬", short: "호일룬" },
  { id: "P109", from: "Randal Kolo Muani", ko: "랑달 콜로 무아니", short: "콜로 무아니" },
  { id: "P110", from: "Cody Gakpo", ko: "코디 하크포", short: "하크포" },
  { id: "P111", from: "Ollie Watkins", ko: "올리 왓킨스", short: "왓킨스" },
  { id: "P112", from: "Alexander Isak", ko: "알렉산더 이사크", short: "이사크" },
  { id: "P113", from: "Dušan Vlahović", ko: "두샨 블라호비치", short: "블라호비치" },
  { id: "P114", from: "Nicolas Jackson", ko: "니콜라 잭슨", short: "잭슨" },
  { id: "P115", from: "Serhou Guirassy", ko: "세루 기라시", short: "기라시" },
  { id: "P116", from: "Giorgi Mamardashvili", ko: "기오르기 마마르다슈빌리", short: "마마르다슈빌리" },
  { id: "P117", from: "Guglielmo Vicario", ko: "굴리엘모 비카리오", short: "비카리오" },
  { id: "P118", from: "Rico Lewis", ko: "리코 루이스", short: "루이스" },
  { id: "P119", from: "Levi Colwill", ko: "리바이 콜윌", short: "콜윌" },
  { id: "P120", from: "Leny Yoro", ko: "르니 요로", short: "요로" },
  { id: "P121", from: "Nico Schlotterbeck", ko: "니코 슐로터베크", short: "슐로터베크" },
  { id: "P122", from: "Castello Lukeba", ko: "카스텔로 루케바", short: "루케바" },
  { id: "P123", from: "Riccardo Calafiori", ko: "리카르도 칼라피오리", short: "칼라피오리" },
  { id: "P124", from: "Giorgio Scalvini", ko: "조르조 스칼비니", short: "스칼비니" },
  { id: "P125", from: "Jarrad Branthwaite", ko: "재러드 브랜스웨이트", short: "브랜스웨이트" },
  { id: "P126", from: "Micky van de Ven", ko: "미키 판 더 벤", short: "판 더 벤" },
  { id: "P127", from: "Warren Zaïre-Emery", ko: "워런 자이르에메리", short: "자이르에메리" },
  { id: "P128", from: "Kobbie Mainoo", ko: "코비 마이누", short: "마이누" },
  { id: "P129", from: "Gavi", ko: "가비", short: "가비" },
  { id: "P130", from: "Arda Güler", ko: "아르다 귈레르", short: "귈레르" },
  { id: "P131", from: "Carlos Baleba", ko: "카를로스 발레바", short: "발레바" },
  { id: "P132", from: "Adam Wharton", ko: "애덤 와튼", short: "와튼" },
  { id: "P133", from: "João Neves", ko: "주앙 네베스", short: "네베스" },
  { id: "P134", from: "Manu Koné", ko: "마누 코네", short: "코네" },
  { id: "P135", from: "Ángel Gomes", ko: "앙헬 고메스", short: "고메스" },
  { id: "P136", from: "Endrick", ko: "엔드릭", short: "엔드릭" },
  { id: "P137", from: "Mathys Tel", ko: "마티스 텔", short: "텔" },
  { id: "P138", from: "Benjamin Šeško", ko: "베냐민 셰슈코", short: "셰슈코" },
  { id: "P139", from: "Johan Bakayoko", ko: "요한 바카요코", short: "바카요코" },
  { id: "P140", from: "Karim Adeyemi", ko: "카림 아데예미", short: "아데예미" },
  { id: "P141", from: "Hugo Ekitike", ko: "위고 에키티케", short: "에키티케" },
  { id: "P142", from: "Alejandro Garnacho", ko: "알레한드로 가르나초", short: "가르나초" },
  { id: "P143", from: "Park Ji-sung", ko: "박지성", short: "박지성" },
  { id: "P144", from: "Cha Bum-kun", ko: "차범근", short: "차범근" },
  { id: "P145", from: "Lee Kang-in", ko: "이강인", short: "이강인" },
  { id: "P146", from: "Ki Sung-yueng", ko: "기성용", short: "기성용" },
  { id: "P147", from: "Yoo Sang-chul", ko: "유상철", short: "유상철" },
  { id: "P148", from: "Hong Myung-bo", ko: "홍명보", short: "홍명보" },
  { id: "P149", from: "Lee Young-pyo", ko: "이영표", short: "이영표" },
  { id: "P150", from: "Kim Joo-sung", ko: "김주성", short: "김주성" },
  { id: "P151", from: "Hwang Hee-chan", ko: "황희찬", short: "황희찬" },
  { id: "P152", from: "Ahn Jung-hwan", ko: "안정환", short: "안정환" },
  { id: "P153", from: "Lee Dong-gook", ko: "이동국", short: "이동국" },
  { id: "P154", from: "Hwang Sun-hong", ko: "황선홍", short: "황선홍" },
  { id: "P155", from: "Lee Jae-sung", ko: "이재성", short: "이재성" },
  { id: "P156", from: "Hwang In-beom", ko: "황인범", short: "황인범" },
  { id: "P157", from: "Koo Ja-cheol", ko: "구자철", short: "구자철" },
  { id: "P158", from: "Lee Chung-yong", ko: "이청용", short: "이청용" },
  { id: "P159", from: "Kim Young-gwon", ko: "김영권", short: "김영권" },
  { id: "P160", from: "Kim Jin-su", ko: "김진수", short: "김진수" },
  { id: "P161", from: "Cho Hyun-woo", ko: "조현우", short: "조현우" },
  { id: "P162", from: "Park Chu-young", ko: "박주영", short: "박주영" },
  { id: "P163", from: "Seol Ki-hyeon", ko: "설기현", short: "설기현" },
  { id: "P164", from: "Cho Gue-sung", ko: "조규성", short: "조규성" },
  { id: "P165", from: "Bae Jun-ho", ko: "배준호", short: "배준호" },
  { id: "P166", from: "Hong Hyun-seok", ko: "홍현석", short: "홍현석" },
  { id: "P167", from: "Paik Seung-ho", ko: "백승호", short: "백승호" },
  { id: "P168", from: "Seol Young-woo", ko: "설영우", short: "설영우" },
  { id: "P169", from: "Kim Seung-gyu", ko: "김승규", short: "김승규" },
  { id: "P170", from: "Yang Min-hyuk", ko: "양민혁", short: "양민혁" },
  { id: "P171", from: "Oh Hyeon-gyu", ko: "오현규", short: "오현규" },
  { id: "P172", from: "Yang Hyun-jun", ko: "양현준", short: "양현준" },
  { id: "P173", from: "보날두", short: "보날두" }, // 패러디 — 개명 대상 아님(안 C)
  { id: "P174", from: "권씨", short: "권씨" }, // 패러디 — 개명 대상 아님(안 C)
  { id: "P175", from: "열라도나", short: "열라도나" }, // 패러디 — 개명 대상 아님(안 C)
  { id: "P176", from: "춘바페", short: "춘바페" }, // 패러디 — 개명 대상 아님(안 C)
  { id: "P177", from: "덕브라이너", short: "덕브라" }, // 패러디 — 개명 대상 아님(안 C)
  { id: "P178", from: "석신", short: "석신" }, // 패러디 — 개명 대상 아님(안 C)
  { id: "P179", from: "욱링엄", short: "욱링엄" }, // 패러디 — 개명 대상 아님(안 C)
  { id: "P180", from: "경니시우스", short: "경니시" }, // 패러디 — 개명 대상 아님(안 C)
  { id: "P181", from: "석다이크", short: "석다이크" }, // 패러디 — 개명 대상 아님(안 C)
  { id: "P182", from: "오시야스", short: "오시야스" }, // 패러디 — 개명 대상 아님(안 C)
];
