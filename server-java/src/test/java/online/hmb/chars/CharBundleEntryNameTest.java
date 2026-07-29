package online.hmb.chars;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import online.hmb.common.ApiException;
import org.junit.jupiter.api.Test;

/**
 * zip 엔트리 이름 규칙의 <b>단독 계약</b> (#309 W2).
 *
 * <p><b>왜 API 테스트만으로 부족한가</b>(변이체 실험으로 확인했다): zip-slip 방어가 <b>두 층</b>이라
 * ({@code normalizeEntryName} 의 이름 검사 + {@code writeEntry} 의 해제 경로 재확인) 한 층을 지워도
 * {@code CharBundleApiTest.zipSlipEntriesAreRejected} 는 <b>통과한다</b> — 다른 층이 잡기 때문이다.
 * 그건 심층방어가 제대로 동작한다는 뜻이지만, 동시에 <b>한 층이 조용히 죽어도 아무도 모른다</b>는 뜻이다
 * (두 층을 다 지우면 그 테스트가 실패하는 것은 확인했다 = 계약이 공허하지는 않다).
 *
 * <p>그래서 이 파일이 <b>첫 번째 층에만</b> 계약을 건다. 두 층이 각자 자기 시험을 받는다.
 */
class CharBundleEntryNameTest {

    @Test
    void parentSegmentsAreRejectedWhereverTheyAppear() {
        for (String evil : List.of("../x.png", "a/../../x.png", "units/../../../etc/passwd", "..")) {
            assertThatThrownBy(() -> CharBundleStorage.normalizeEntryName(evil))
                    .as("zip-slip: " + evil)
                    .isInstanceOf(ApiException.class);
        }
    }

    @Test
    void absolutePathsAreRejected() {
        assertThatThrownBy(() -> CharBundleStorage.normalizeEntryName("/etc/passwd"))
                .isInstanceOf(ApiException.class);
    }

    /**
     * ⚠️ 역슬래시를 슬래시로 정규화<b>한 뒤</b> 검사한다. 안 그러면 윈도 zip 이 만든
     * {@code ..\..\x.png} 가 세그먼트 분해를 통과해 버린다(공지 본문 URL 살균이 같은 함정을
     * 겪었다 — {@code notice-markup.ts} 의 역슬래시 주석 참조).
     */
    @Test
    void backslashSeparatorsAreNormalizedBeforeChecking() {
        assertThatThrownBy(() -> CharBundleStorage.normalizeEntryName("..\\..\\x.png"))
                .isInstanceOf(ApiException.class);
        assertThat(CharBundleStorage.normalizeEntryName("units\\a.png")).isEqualTo("units/a.png");
    }

    @Test
    void archiveNoiseIsSkippedNotRejected() {
        assertThat(CharBundleStorage.normalizeEntryName("__MACOSX/units/._a.png")).isNull();
        assertThat(CharBundleStorage.normalizeEntryName(".DS_Store")).isNull();
        assertThat(CharBundleStorage.normalizeEntryName("units/.DS_Store")).isNull();
    }

    @Test
    void ordinaryNamesPassThrough() {
        assertThat(CharBundleStorage.normalizeEntryName("units/manifest.json")).isEqualTo("units/manifest.json");
        assertThat(CharBundleStorage.normalizeEntryName(" manifest.json ")).isEqualTo("manifest.json");
    }

    /** 루트 폴더 한 겹은 벗긴다 — zip 툴 차이로 운영자가 "필수 파일 없음"을 보지 않게. */
    @Test
    void aSingleCommonRootFolderIsStripped() {
        assertThat(CharBundleStorage.stripCommonRoot(List.of("chars/manifest.json", "chars/units/a.png")))
                .containsExactly("manifest.json", "units/a.png");
    }

    /** ⚠️ 접두사가 갈리면 <b>벗기지 않는다</b> — 벗기면 `units/` 같은 진짜 디렉토리가 사라진다. */
    @Test
    void aSharedPrefixThatIsNotACommonRootIsKept() {
        List<String> names = List.of("manifest.json", "units/a.png");
        assertThat(CharBundleStorage.stripCommonRoot(names)).isEqualTo(names);
    }
}
