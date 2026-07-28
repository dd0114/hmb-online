package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import online.hmb.catalog.EconomyService;
import online.hmb.catalog.EconomyService.Currency;
import online.hmb.common.Josa;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * 재화 <b>표기 메타</b> 로더 계약 (#232). 스프링 없이 순수 로더만 태운다.
 *
 * <p>여기서 지키는 것은 값이 아니라 <b>성질</b>이다: ① 파일이 없어도 표기가 비지 않는다
 * ② 부분 override 가 성립한다(한 글자 바꾸려고 전체를 옮겨 적지 않아도 된다) ③ 모르는 코드도
 * 살아남는다(재화가 늘 때 서버 배포가 필요 없다). 심볼 값 자체를 박으면 hero 가 표기를 바꿀 때마다
 * 테스트가 깨져 "표기는 데이터"라는 전제와 모순된다 — 그래서 기본값 단언은 <b>코드 집합</b>에만 건다.
 */
class CurrencyMetaTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static List<Currency> load(Path file) {
        return new EconomyService(MAPPER, file.toString()).currencies();
    }

    private static Path write(Path dir, String name, String json) throws Exception {
        Path p = dir.resolve(name);
        Files.writeString(p, json);
        return p;
    }

    /**
     * <b>hero 확정 표기 핀</b> (#232: 다이아=Z, 골드=G).
     *
     * <p>다른 테스트들은 일부러 심볼 <b>값</b>을 단언하지 않는다 — 표기는 데이터고, 값을 박으면
     * 표기를 바꿀 때마다 테스트가 깨져 "표기는 데이터"라는 전제와 모순되기 때문이다. 그런데
     * 지금은 발행물(`data/players/economy.v3.json`)에 {@code currencies} 가 <b>없어서</b> 실배포
     * 값이 전부 이 상수에서 나온다 = 값이 사실상 <b>코드</b>다. 그 상태에서 아무도 값을 안 보면
     * {@code DEFAULT_CURRENCIES} 를 "P"/"포인트"로 되돌려도 전 게이트가 green 이다(독립검증 MJ-4).
     *
     * <p>그래서 <b>기본값 한 곳만</b> 핀으로 박는다. 발행물이 {@code currencies} 를 싣는 순간
     * (계획된 (a)→(b) 승격) 이 상수는 폴백으로 물러나고, 그때 이 테스트는 발행물 쪽으로 옮긴다.
     */
    @Test
    void defaultDisplayMatchesTheConfirmedNotation() {
        Currency point = EconomyService.currencyOf(EconomyService.DEFAULT_CURRENCIES,
                EconomyService.CURRENCY_POINT);
        Currency gem = EconomyService.currencyOf(EconomyService.DEFAULT_CURRENCIES,
                EconomyService.CURRENCY_GEM);
        assertThat(point.symbol()).isEqualTo("G");
        assertThat(point.name()).isEqualTo("골드");
        assertThat(gem.symbol()).isEqualTo("Z");
        assertThat(gem.name()).isEqualTo("다이아");
    }

    /** economy 파일이 아예 없어도 표기는 나와야 한다 — 빈 단위가 화면에 나가는 것이 최악이다. */
    @Test
    void missingEconomyStillYieldsUsableCurrencyMeta(@TempDir Path dir) {
        List<Currency> currencies = load(dir.resolve("nope.json"));
        assertThat(currencies).extracting(Currency::code)
                .containsExactly(EconomyService.CURRENCY_POINT, EconomyService.CURRENCY_GEM);
        assertThat(currencies).allSatisfy(c -> {
            assertThat(c.symbol()).isNotBlank();
            assertThat(c.name()).isNotBlank();
            assertThat(c.position()).isIn("prefix", "suffix");
        });
    }

    /** currencies 블록이 없는 구파일도 같은 기본 표기로 뜬다(폴백 = 배포 롤백 안전망). */
    @Test
    void fileWithoutCurrenciesBlockFallsBackToDefaults(@TempDir Path dir) throws Exception {
        Path f = write(dir, "e.json", "{\"version\":\"x\",\"initialPoints\":1}");
        assertThat(load(f)).isEqualTo(EconomyService.DEFAULT_CURRENCIES);
    }

    /**
     * <b>부분 override</b> — 심볼 하나만 올려도 나머지(이름·아이콘·자리)는 기본값이 유지된다.
     * 통짜 교체만 지원하면 운영자가 빠뜨린 필드가 빈 문자열로 화면에 나간다.
     */
    @Test
    void partialOverrideReplacesOnlyNamedFields(@TempDir Path dir) throws Exception {
        Path f = write(dir, "e.json", """
                {"version":"x","currencies":[{"code":"GEM","symbol":"D"}]}
                """);
        List<Currency> out = load(f);
        Currency gem = EconomyService.currencyOf(out, EconomyService.CURRENCY_GEM);
        Currency defaultGem = EconomyService.currencyOf(
                EconomyService.DEFAULT_CURRENCIES, EconomyService.CURRENCY_GEM);
        assertThat(gem.symbol()).isEqualTo("D");
        assertThat(gem.name()).isEqualTo(defaultGem.name());
        assertThat(gem.icon()).isEqualTo(defaultGem.icon());
        assertThat(gem.position()).isEqualTo(defaultGem.position());
        // 언급하지 않은 재화는 통째로 기본값.
        assertThat(EconomyService.currencyOf(out, EconomyService.CURRENCY_POINT))
                .isEqualTo(EconomyService.currencyOf(EconomyService.DEFAULT_CURRENCIES,
                        EconomyService.CURRENCY_POINT));
    }

    /** 전 필드 override 가 그대로 실린다 — 이게 "무배포로 표기를 바꾼다"의 실체다. */
    @Test
    void fullOverrideWins(@TempDir Path dir) throws Exception {
        Path f = write(dir, "e.json", """
                {"version":"x","currencies":[
                  {"code":"POINT","symbol":"Ω","name":"오메가","icon":"◆","position":"prefix","separator":""}
                ]}
                """);
        Currency point = EconomyService.currencyOf(load(f), EconomyService.CURRENCY_POINT);
        assertThat(point).isEqualTo(new Currency("POINT", "Ω", "오메가", "◆", "prefix", ""));
    }

    /** separator 는 빈 문자열이 <b>의미 있는 값</b>(붙여쓰기)이라 blank 폴백이 걸리면 안 된다. */
    @Test
    void emptySeparatorIsHonoredNotTreatedAsMissing(@TempDir Path dir) throws Exception {
        Path f = write(dir, "e.json", """
                {"version":"x","currencies":[{"code":"POINT","separator":""}]}
                """);
        assertThat(EconomyService.currencyOf(load(f), EconomyService.CURRENCY_POINT).separator()).isEmpty();
    }

    /**
     * {@code icon} 도 빈 문자열로 <b>끌 수 있어야</b> 한다 — 클라 계약이 "빈 문자열이면 안 그린다"인데
     * 서버가 그 값을 못 내면 아이콘 제거가 배포 작업이 된다(독립검증 minor).
     */
    @Test
    void emptyIconTurnsTheIconOff(@TempDir Path dir) throws Exception {
        Path f = write(dir, "e.json", """
                {"version":"x","currencies":[{"code":"GEM","icon":""}]}
                """);
        assertThat(EconomyService.currencyOf(load(f), EconomyService.CURRENCY_GEM).icon()).isEmpty();
    }

    /** 모르는 코드도 버리지 않는다 — 재화가 늘어날 때 서버 코드 수정 없이 실린다. */
    @Test
    void unknownCurrencyCodeSurvives(@TempDir Path dir) throws Exception {
        Path f = write(dir, "e.json", """
                {"version":"x","currencies":[{"code":"TICKET","symbol":"T","name":"티켓"}]}
                """);
        List<Currency> out = load(f);
        assertThat(out).extracting(Currency::code)
                .containsExactly(EconomyService.CURRENCY_POINT, EconomyService.CURRENCY_GEM, "TICKET");
        assertThat(EconomyService.currencyOf(out, "TICKET").symbol()).isEqualTo("T");
    }

    /** 모르는 코드를 조회하면 코드 자체가 폴백 — 문자열이 비어 화면이 공백이 되는 일은 없다. */
    @Test
    void lookupOfUnknownCodeNeverReturnsBlank() {
        Currency c = EconomyService.currencyOf(EconomyService.DEFAULT_CURRENCIES, "MYSTERY");
        assertThat(c.symbol()).isEqualTo("MYSTERY");
        assertThat(c.name()).isEqualTo("MYSTERY");
    }

    /**
     * 조사 선택 — 재화 이름이 데이터가 되면서 필요해진 규칙. 이름이 바뀌어도 "다이아이 부족합니다"
     * 같은 문장이 나가지 않아야 한다.
     */
    @Test
    void josaFollowsFinalConsonantOfTheName() {
        assertThat(Josa.iga("골드")).isEqualTo("골드가");     // 받침 없음
        assertThat(Josa.iga("다이아")).isEqualTo("다이아가"); // 받침 없음
        assertThat(Josa.iga("젬")).isEqualTo("젬이");         // 받침 있음
        assertThat(Josa.iga("포인트")).isEqualTo("포인트가");
        assertThat(Josa.eunneun("골드")).isEqualTo("골드는");
        assertThat(Josa.eunneun("젬")).isEqualTo("젬은");
        // 한글이 아닌 폴백 이름은 "이/은" 쪽 — 어색해도 틀린 말은 아니다.
        assertThat(Josa.iga("GEM")).isEqualTo("GEM이");
    }
}
