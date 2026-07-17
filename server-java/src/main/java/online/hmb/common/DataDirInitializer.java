package online.hmb.common;

import java.io.File;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.env.EnvironmentPostProcessor;
import org.springframework.core.env.ConfigurableEnvironment;

/**
 * hmb.db.path(SQLite 파일 경로)의 부모 디렉토리를 DataSource/Flyway 빈 생성 전에 만든다.
 * sqlite-jdbc는 부모 디렉토리를 자동 생성하지 않으므로, 이게 없으면 최초 부팅(또는 .data/ 삭제
 * 후 재부팅) 시 "does not exist"로 즉시 실패한다. EnvironmentPostProcessor는 컨텍스트 리프레시
 * 전(환경 로딩 직후)에 실행돼 DataSource 자동설정보다 먼저 동작한다.
 */
public class DataDirInitializer implements EnvironmentPostProcessor {

    @Override
    public void postProcessEnvironment(ConfigurableEnvironment environment, SpringApplication application) {
        String dbPath = environment.getProperty("hmb.db.path", "./.data/hmb.db");
        File dbFile = new File(dbPath);
        File parent = dbFile.getParentFile();
        if (parent != null && !parent.exists()) {
            parent.mkdirs();
        }
    }
}
