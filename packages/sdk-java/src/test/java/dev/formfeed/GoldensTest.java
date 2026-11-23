package dev.formfeed;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * The contract goldens (plan 25 §5.3): what the API answers today, written by the gateway's {@code
 * contract.spec.ts}. Each is read with the model its name starts with, so a change of an answer
 * that the SDK cannot read fails here before it ships. They live in the Formfeed repository only;
 * the public repository carries the shared vectors without them, and skips these tests.
 */
final class GoldensTest {
  private static Path folder() {
    return ClientTestCase.packageDir().resolve("../api-types/fixtures/contract").normalize();
  }

  private static List<Path> goldens() {
    if (!Files.isDirectory(folder())) {
      return List.of();
    }
    try (Stream<Path> files = Files.list(folder())) {
      return files
          .filter(file -> file.getFileName().toString().endsWith(".json"))
          .sorted()
          .collect(Collectors.toList());
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }

  @Test
  void thereAreGoldens() {
    Assumptions.assumeTrue(
        Files.isDirectory(folder()),
        "outside the Formfeed repository, which holds the contract goldens");
    assertFalse(goldens().isEmpty());
  }

  @TestFactory
  Stream<DynamicTest> theSdkReadsTheGolden() {
    return goldens().stream()
        .map(file -> DynamicTest.dynamicTest(file.getFileName().toString(), () -> read(file)));
  }

  private static void read(Path file) {
    Map<String, Object> data = ClientTestCase.json(file);
    String name = file.getFileName().toString().replaceFirst("\\.json$", "");
    if (name.equals("render-page") || name.startsWith("render-page-")) {
      Page<Render> page = Page.fromMap(data, Render::fromMap);
      assertFalse(page.getData().isEmpty());
      for (Render render : page.getData()) {
        assertTrue(render.getId().startsWith("rnd_"), render.getId());
      }
    } else if (name.equals("render-input") || name.startsWith("render-input-")) {
      assertTrue(RenderInput.fromMap(data).getRenderId().startsWith("rnd_"));
    } else if (name.startsWith("render")) {
      Render render = Render.fromMap(data);
      assertTrue(render.getId().startsWith("rnd_"), render.getId());
      assertNotEquals("", render.getStatus());
    } else if (name.startsWith("job")) {
      Job job = Job.fromMap(data);
      assertTrue(job.getId().startsWith("job_"), job.getId());
      assertEquals(job.getTotal(), job.getItems().size());
    } else {
      fail(name + ".json: no model is named for this file");
    }
  }
}
