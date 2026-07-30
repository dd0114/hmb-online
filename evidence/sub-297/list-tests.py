"""게이트 로그에 '무엇이 실제로 실행됐나'를 붙인다.

gradle 은 성공한 테스트를 표준출력에 찍지 않는다 — 로그에 BUILD SUCCESSFUL 만 남으면
"필터가 0건을 잡았는데 성공"과 구분되지 않는다(거짓 green 의 전형). JUnit XML 결과를
읽어 케이스별 PASSED/SKIPPED 를 열거해 스킵이 아님을 증명한다.

사용: python3 evidence/sub-297/list-tests.py server-java/build/test-results/test
"""
import glob
import os
import sys
import xml.etree.ElementTree as ET

results_dir = sys.argv[1] if len(sys.argv) > 1 else "server-java/build/test-results/test"

print("")
print("=== 실행된 테스트 목록 (%s — 스킵 아님을 증명) ===" % results_dir)
files = sorted(glob.glob(os.path.join(results_dir, "TEST-*.xml")))
if not files:
    print("!! 결과 XML 이 0건이다 — 테스트 필터가 아무것도 못 잡았다는 뜻이다")
    sys.exit(1)
total = 0
for f in files:
    root = ET.parse(f).getroot()
    print("%s: tests=%s failures=%s errors=%s skipped=%s" % (
        root.get("name"), root.get("tests"), root.get("failures"),
        root.get("errors"), root.get("skipped")))
    for tc in root.findall("testcase"):
        if tc.find("skipped") is not None:
            state = "SKIPPED"
        elif tc.find("failure") is not None or tc.find("error") is not None:
            state = "FAILED"
        else:
            state = "PASSED"
        total += 1
        print("  [%s] %s  (%ss)" % (state, tc.get("name"), tc.get("time")))
print("총 %d 케이스" % total)
